import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InputCaptureSession } from '../../src/audio/AudioEngineInterface';
import { TrackAudio } from '../../src/audio/TrackAudio';
import { PcmHistoryBudget, BROWSER_PCM_HISTORY_BUDGET_BYTES } from '../../src/audio/PcmHistoryBudget';
import { Track, TrackState } from '../../src/core/types';
import { Transport } from '../../src/core/Transport';
import { createMockAudioContext } from '../helpers/audioTestUtils';

class FakePort {
    onmessage: ((event: { data: any }) => void) | null = null;
    posted: any[] = [];
    closed = false;
    postMessage(message: any) { this.posted.push({ ...message }); }
    receive(data: any) { this.onmessage?.({ data }); }
    close() { this.closed = true; }
}

class FakeWorklet {
    static instances: FakeWorklet[] = [];
    readonly port = new FakePort();
    onprocessorerror: (() => void) | null = null;
    disconnected = false;
    constructor(_context: AudioContext, readonly name: string) { FakeWorklet.instances.push(this); }
    connect() {}
    disconnect() { this.disconnected = true; }
}

function createHarness(budget?: PcmHistoryBudget, count = 2) {
    const context = createMockAudioContext();
    const transport = Transport.getInstance();
    const input = context.createGain();
    const engine = {
        context, roundTripLatency: 0, trackMixNode: context.createGain(), tracks: [] as TrackAudio[],
        getInputStream: async () => context.createMediaStreamSource({} as MediaStream),
        getProcessedInputNode: vi.fn(async (): Promise<AudioNode> => input),
        checkAndResetMaster: vi.fn((id: number) => {
            if (transport.masterTrackId === id && !engine.tracks.some((track) => track.track.id !== id && track.state !== TrackState.EMPTY)) {
                transport.resetMasterTrack();
            }
        }),
    };
    engine.tracks = Array.from({ length: count }, (_, index) =>
        new TrackAudio(engine, new Track(index + 1), index, null, null, budget));
    return { context, engine, tracks: engine.tracks, transport, input };
}

function installSharedCapture(engine: any, startFrame = 100) {
    const emitted: unknown[] = [];
    const session = {
        node: {} as AudioWorkletNode,
        trackIndex: 0,
        sessionId: 73,
        inputGeneration: 4,
        startFrame,
        maxRecordingFrames: 8_192,
    };
    let listener: ((message: unknown) => void) | null = null;
    engine.getInputCaptureRequestFrame = vi.fn(() => startFrame);
    engine.beginInputCaptureSession = vi.fn((trackIndex: number, frame: number, onMessage: (message: unknown) => void, maxRecordingFrames?: number) => {
        if (trackIndex !== 0 || frame !== startFrame || maxRecordingFrames !== 8_192) return null;
        listener = onMessage;
        return session;
    });
    engine.stopInputCaptureSession = vi.fn((_captureSession: unknown, _stopFrame: number) => true);
    engine.abortInputCaptureSession = vi.fn();
    engine.recycleInputCaptureChunk = vi.fn(() => true);
    engine.releaseInputCaptureSession = vi.fn();
    return {
        session,
        emitted,
        send(message: unknown) {
            emitted.push(message);
            listener?.(message);
        },
    };
}

function bufferOf(track: TrackAudio): AudioBuffer | null { return (track as any).audioBuffer; }
function channelsOf(track: TrackAudio) {
    const buffer = bufferOf(track);
    return buffer ? Array.from({ length: buffer.numberOfChannels }, (_, channel) => Array.from(buffer.getChannelData(channel))) : null;
}
function pcmBits(track: TrackAudio) {
    const buffer = bufferOf(track)!;
    return Array.from({ length: buffer.numberOfChannels }, (_, channel) => {
        const data = buffer.getChannelData(channel);
        return Array.from(new Uint32Array(data.buffer, data.byteOffset, data.length));
    });
}
function record(track: TrackAudio, channels: number[][]) {
    (track as any).resumeAfterRecording = false;
    (track as any).processRecordedBuffers(channels.map((channel) => Float32Array.from(channel)));
}
async function settle() { for (let index = 0; index < 8; index += 1) await Promise.resolve(); }
async function overdub(track: TrackAudio) {
    track.state = TrackState.PLAYING;
    track.triggerRecord();
    await settle();
    return FakeWorklet.instances.at(-1)!;
}
function patch(track: TrackAudio, node: FakeWorklet, sequence: number, index: number, left: number, right?: number, inputFrame = 100 + sequence) {
    const buffer = bufferOf(track)!;
    node.port.receive({ type: 'OVERDUB_PATCH', sequence, slotIndex: 0, validFrames: 1,
        startInputFrame: inputFrame, endInputFrame: inputFrame + 1,
        indices: new Uint32Array([index]), values: new Float32Array([left]),
        oldValues: new Float32Array([buffer.getChannelData(0)[index]!]),
        ...(right === undefined ? {} : {
            rightValues: new Float32Array([right]), oldRightValues: new Float32Array([buffer.getChannelData(1)[index]!]),
        }),
    });
}
function finishOverdub(track: TrackAudio, node: FakeWorklet, patchesSent: number) {
    const engine = (track as any).engine;
    engine.getInputCaptureRequestFrame = () => 1_000_000;
    track.triggerRecord();
    node.port.receive({ type: 'OVERDUB_STOPPED', patchesSent, overflowFrames: 0, overflowEvents: 0,
        requestedStopFrame: 1_000_000, appliedExclusiveEnd: 1_000_000, processorStopFrame: 1_000_000 });
}

beforeEach(() => {
    FakeWorklet.instances = [];
    vi.stubGlobal('AudioWorkletNode', FakeWorklet);
    localStorage.clear();
    Transport.getInstance().stop();
    Transport.getInstance().resetMasterTrack();
});
afterEach(() => {
    Transport.getInstance().stop();
    vi.unstubAllGlobals();
});

describe('Browser shared PCM history admission', () => {
    it('keeps an empty track recordable after stop-before-first-frame and preserves an incumbent loop', async () => {
        const { tracks: [track] } = createHarness();
        const completeEmptyTake = async () => {
            const node = FakeWorklet.instances.at(-1);
            if (!node) throw new Error('Expected recording worklet');
            track.triggerStop();
            expect(node.port.posted.at(-1)?.type).toBe('STOP_RECORD');
            node.port.receive({
                type: 'RECORD_COMPLETE', framesCaptured: 0, droppedFrames: 0, overflowEvents: 0,
                maxRecordingFrames: 8_192, limitReached: false, chunksSent: 0,
            });
        };

        await track.startRecording();
        expect(track.state).toBe(TrackState.RECORDING);
        await completeEmptyTake();
        expect(track.state).toBe(TrackState.EMPTY);
        expect(bufferOf(track)).toBeNull();
        expect(track.recordingDiagnostic).toContain('track remains empty');
        expect(track.historyBusy).toBe(false);

        // Pressing Record after the empty completion must create a new take,
        // rather than route to play() with a missing AudioBuffer.
        track.triggerRecord();
        await settle();
        expect(FakeWorklet.instances).toHaveLength(2);
        expect(track.state).toBe(TrackState.RECORDING);
        expect(track.recordingDiagnostic).toBeNull();
        await completeEmptyTake();
        expect(track.state).toBe(TrackState.EMPTY);
        expect(track.recordingDiagnostic).toContain('track remains empty');
        expect(FakeWorklet.instances).toHaveLength(2);

        // Even if an incumbent PCM buffer exists through a direct recorder call,
        // an empty replacement must keep its exact PCM and stopped status.
        record(track, [[0.125, -0, 0.75], [-0.5, 0.25, 0.375]]);
        const incumbent = pcmBits(track);
        expect(track.state).toBe(TrackState.STOPPED);
        await track.startRecording();
        await completeEmptyTake();
        expect(track.state).toBe(TrackState.STOPPED);
        expect(track.recordingDiagnostic).toContain('previous loop was preserved');
        expect(pcmBits(track)).toEqual(incumbent);
    });

    it('preflights and atomically replaces several history owners against the shared cap', () => {
        const budget = new PcmHistoryBudget(24);
        const first = {}, second = {}, third = {};
        expect(budget.replace(first, 8)).toBe(true);
        expect(budget.replace(second, 8)).toBe(true);
        expect(budget.canReplaceMany([{ owner: first, bytes: 13 }, { owner: second, bytes: 13 }])).toBe(false);
        expect(budget.replaceMany([{ owner: first, bytes: 13 }, { owner: second, bytes: 13 }])).toBe(false);
        expect(budget.retainedBytes).toBe(16);
        expect(budget.canReplaceMany([{ owner: first, bytes: 13 }, { owner: second, bytes: 13 }])).toBe(false);
        expect(budget.replaceMany([{ owner: first, bytes: 8 }, { owner: second, bytes: 12 }])).toBe(true);
        expect(budget.retainedBytes).toBe(20);
        expect(budget.replaceMany([{ owner: first, bytes: 8 }, { owner: third, bytes: 4 }])).toBe(true);
        expect(budget.retainedBytes).toBe(24);
        expect(budget.canReplaceMany([{ owner: first, bytes: 1 }, { owner: first, bytes: 2 }])).toBe(false);
    });

    it('admits exactly 512 MiB of retained PCM across owners, without allocating a huge loop', () => {
        const budget = new PcmHistoryBudget();
        const first = {}, second = {}, third = {};
        expect(budget.limitBytes).toBe(536_870_912);
        expect(budget.limitBytes).toBe(BROWSER_PCM_HISTORY_BUDGET_BYTES);
        expect(budget.replace(first, 384 * 1024 * 1024)).toBe(true);
        expect(budget.replace(second, 128 * 1024 * 1024)).toBe(true);
        expect(budget.retainedBytes).toBe(512 * 1024 * 1024);
        expect(budget.replace(third, 4)).toBe(false);
        expect(budget.replace(first, 384 * 1024 * 1024 + 4)).toBe(false);
        expect(budget.retainedBytes).toBe(budget.limitBytes);
        expect(budget.replace(first, 256 * 1024 * 1024)).toBe(true);
        expect(budget.replace(third, 128 * 1024 * 1024)).toBe(true);
        expect(budget.retainedBytes).toBe(budget.limitBytes);
        budget.release(second);
        expect(budget.retainedBytes).toBe(384 * 1024 * 1024);
        expect(budget.replace(third, Number.NaN)).toBe(false);
        expect(() => new PcmHistoryBudget(-1)).toThrow(RangeError);
    });

    it('shares actual stereo snapshot bytes within one engine and isolates other engines', () => {
        const { tracks: [first, second] } = createHarness();
        const { tracks: [other] } = createHarness();
        record(first, [[1, 2, 3, 4], [-1, -2, -3, -4]]);
        record(second, [[5, 6, 7, 8], [-5, -6, -7, -8]]);
        expect(first.historyRetainedBytes).toBe(0); // Empty pre-record snapshot.
        expect(first.clear()).toBe(true);
        expect(first.historyRetainedBytes).toBe(32);
        expect(second.historyTotalRetainedBytes).toBe(32);
        expect(other.historyTotalRetainedBytes).toBe(0);
        expect(second.clear()).toBe(true);
        expect(first.historyTotalRetainedBytes).toBe(64);
        expect(first.undo()).toBe(true);
        expect(first.historyRetainedBytes).toBe(0);
        expect(first.historyTotalRetainedBytes).toBe(32);
        expect(first.redo()).toBe(true);
        expect(first.historyTotalRetainedBytes).toBe(64);
    });

    it('rejects overdub before mutation when history plus rollback PCM exceed the shared cap', async () => {
        const budget = new PcmHistoryBudget(32);
        const { tracks: [first, second] } = createHarness(budget);
        record(first, [[1, 2, 3, 4], [11, 12, 13, 14]]);
        record(second, [[5, 6, 7, 8], [15, 16, 17, 18]]);
        expect(first.clear()).toBe(true); // All 32 bytes retained for first.
        const before = pcmBits(second);
        const historyBefore = { undo: second.canUndo, redo: second.canRedo, bytes: second.historyTotalRetainedBytes };
        second.state = TrackState.PLAYING;
        second.triggerRecord();
        await settle();
        expect(FakeWorklet.instances).toHaveLength(0); // Admission happens before worklet creation or a PCM patch.
        expect(second.state).toBe(TrackState.PLAYING);
        expect(second.overdubDiagnostic).toContain('shared Browser PCM history budget');
        expect(pcmBits(second)).toEqual(before);
        expect({ undo: second.canUndo, redo: second.canRedo, bytes: second.historyTotalRetainedBytes }).toEqual(historyBefore);
        expect(budget.retainedBytes).toBe(32);
        expect(second.clear()).toBe(false);
        expect(bufferOf(second)).not.toBeNull();
        expect(second.historyUnavailableReason).toContain('Clear was cancelled');
        expect(first.canUndo).toBe(true); // Other track's history was not evicted.
        expect(first.undo()).toBe(true); // Releases 32 bytes.
        expect(second.clear()).toBe(true);
        expect(second.historyRetainedBytes).toBe(32);
    });

    it('rejects an undo swap without changing either state when the inverse cannot fit', () => {
        const budget = new PcmHistoryBudget(32);
        const { tracks: [first, second] } = createHarness(budget);
        record(first, [[1, 2, 3, 4], [11, 12, 13, 14]]);
        record(second, [[5, 6, 7, 8], [15, 16, 17, 18]]);
        second.clear();
        const original = bufferOf(first);
        expect(first.canUndo).toBe(false);
        expect(first.undo()).toBe(false);
        expect(bufferOf(first)).toBe(original);
        expect(first.historyUnavailableReason).toContain('Audio is preserved');
        second.undo();
        expect(first.canUndo).toBe(true);
        expect(first.historyUnavailableReason).toBeNull();
        expect(first.undo()).toBe(true);
        expect(first.state).toBe(TrackState.EMPTY);
    });
});

describe('Browser five-track project replacement', () => {
    it('installs all prepared buffers together and makes each previous loop that track’s undo step', () => {
        const budget = new PcmHistoryBudget(128);
        const { context, tracks } = createHarness(budget, 5);
        for (let index = 0; index < tracks.length; index += 1) {
            record(tracks[index]!, [[index + 0.125, index + 0.25]]);
        }
        const beforeRevisions = tracks.map((track) => track.projectRevision);
        const replacements = [
            context.createBuffer(1, 3, 44100),
            context.createBuffer(2, 2, 44100),
            null,
            context.createBuffer(1, 1, 48000),
            context.createBuffer(2, 1, 48000),
        ];
        replacements[0]!.getChannelData(0).set([0.5, 0.6, 0.7]);
        replacements[1]!.getChannelData(0).set([0.8, 0.9]);
        replacements[1]!.getChannelData(1).set([-0.8, -0.9]);
        replacements[3]!.getChannelData(0)[0] = 0.3;
        replacements[4]!.getChannelData(0)[0] = 0.4;
        replacements[4]!.getChannelData(1)[0] = -0.4;

        const result = TrackAudio.restoreProjectBuffersAtomically(tracks, replacements, beforeRevisions);
        expect(result).toEqual({ ok: true });
        expect(tracks.map((track) => track.state)).toEqual([
            TrackState.STOPPED, TrackState.STOPPED, TrackState.EMPTY, TrackState.STOPPED, TrackState.STOPPED,
        ]);
        expect(tracks.map((track) => track.projectRevision)).toEqual(beforeRevisions.map((revision) => revision + 1));
        expect(pcmBits(tracks[1]!)).toEqual([
            Array.from(new Uint32Array(Float32Array.from([0.8, 0.9]).buffer)),
            Array.from(new Uint32Array(Float32Array.from([-0.8, -0.9]).buffer)),
        ]);
        expect(tracks.every((track) => track.canUndo)).toBe(true);

        for (let index = 0; index < tracks.length; index += 1) expect(tracks[index]!.undo()).toBe(true);
        expect(tracks.map((track) => channelsOf(track))).toEqual([
            [[0.125, 0.25]], [[1.125, 1.25]], [[2.125, 2.25]], [[3.125, 3.25]], [[4.125, 4.25]],
        ]);
    });

    it('rejects the entire project before mutation when the shared undo budget cannot retain all five old loops', () => {
        const budget = new PcmHistoryBudget(16);
        const { context, tracks } = createHarness(budget, 5);
        for (let index = 0; index < tracks.length; index += 1) record(tracks[index]!, [[index + 0.125, index + 0.25]]);
        const oldBuffers = tracks.map((track) => bufferOf(track));
        const oldRevisions = tracks.map((track) => track.projectRevision);
        const oldAudio = tracks.map((track) => channelsOf(track));
        const candidates = tracks.map(() => context.createBuffer(1, 1, 44100));
        const result = TrackAudio.restoreProjectBuffersAtomically(tracks, candidates, oldRevisions);
        expect(result.ok).toBe(false);
        expect(result.reason).toContain('shared PCM history budget');
        expect(tracks.map((track) => bufferOf(track))).toEqual(oldBuffers);
        expect(tracks.map((track) => channelsOf(track))).toEqual(oldAudio);
        expect(tracks.map((track) => track.projectRevision)).toEqual(oldRevisions);
        expect(budget.retainedBytes).toBe(0);
    });

    it('rejects a stale generation without stopping or replacing any track', () => {
        const { context, tracks } = createHarness(undefined, 5);
        for (let index = 0; index < tracks.length; index += 1) record(tracks[index]!, [[index + 0.1]]);
        tracks[2]!.state = TrackState.PLAYING;
        const original = tracks.map((track) => bufferOf(track));
        const revisions = tracks.map((track) => track.projectRevision);
        const candidates = tracks.map(() => context.createBuffer(1, 1, 44100));
        const result = TrackAudio.restoreProjectBuffersAtomically(tracks, candidates, revisions.map((revision, index) => index === 2 ? revision - 1 : revision));
        expect(result.ok).toBe(false);
        expect(tracks.map((track) => track.state)).toEqual([
            TrackState.STOPPED, TrackState.STOPPED, TrackState.PLAYING, TrackState.STOPPED, TrackState.STOPPED,
        ]);
        expect(tracks.map((track) => bufferOf(track))).toEqual(original);
    });
});

describe('Browser per-track one-step PCM history', () => {
    it('undoes record/clear per track, with repeatable redo and independent channel data', () => {
        const { tracks: [first, second] } = createHarness();
        record(first, [[1, 2, 3, 4], [-11, -12, -13, -14]]);
        record(second, [[5, 6, 7, 8], [-15, -16, -17, -18]]);
        const secondPcm = pcmBits(second);
        const firstPcm = pcmBits(first);
        expect(first.undo()).toBe(true);
        expect(first.state).toBe(TrackState.EMPTY);
        expect(first.canUndo).toBe(false);
        expect(first.canRedo).toBe(true);
        expect(pcmBits(second)).toEqual(secondPcm);
        expect(first.redo()).toBe(true);
        expect(pcmBits(first)).toEqual(firstPcm);
        expect(first.canUndo).toBe(true);
        first.isReverse = true;
        expect(first.clear()).toBe(true);
        expect(first.isReverse).toBe(false);
        expect(first.undo()).toBe(true);
        expect(first.isReverse).toBe(true);
        expect(first.state).toBe(TrackState.STOPPED);
        expect(pcmBits(first)).toEqual(firstPcm);
        expect(first.redo()).toBe(true);
        expect(first.state).toBe(TrackState.EMPTY);
        expect(pcmBits(second)).toEqual(secondPcm);
    });

    it('captures pre-overdub stereo bits once, waits for final patches, then swaps exact PCM', async () => {
        const { tracks: [track] } = createHarness();
        record(track, [[0, -0, 0.1, -0.2], [10, -11, 12.5, -13.25]]);
        const original = pcmBits(track);
        const node = await overdub(track);
        patch(track, node, 0, 1, 3.5, 103.5);
        expect(track.historyRetainedBytes).toBe(0); // Previous history is kept authoritative until the edit reaches its terminal barrier.
        expect(track.historyTotalRetainedBytes).toBe(32); // Includes the reserved, pending rollback/undo snapshot.
        expect(track.canUndo).toBe(false);
        expect(track.undo()).toBe(false);
        (track as any).engine.getInputCaptureRequestFrame = () => 102;
        track.triggerRecord(); // Finalization is still asynchronous.
        expect(track.historyBusy).toBe(true);
        patch(track, node, 1, 3, -7.25, -107.25, 101);
        const edited = pcmBits(track);
        node.port.receive({ type: 'OVERDUB_STOPPED', patchesSent: 2, overflowFrames: 0, overflowEvents: 0,
            requestedStopFrame: 102, appliedExclusiveEnd: 102, processorStopFrame: 128 });
        expect(track.historyBusy).toBe(false);
        expect(track.undo()).toBe(true);
        expect(pcmBits(track)).toEqual(original);
        expect(track.redo()).toBe(true);
        expect(pcmBits(track)).toEqual(edited);
        expect(track.historyTotalRetainedBytes).toBe(32);
        expect(node.port.closed).toBe(true);
    });

    it('rolls back already-applied post-stop stereo writes in reverse order across loop wrap', async () => {
        const { tracks: [track], engine } = createHarness();
        record(track, [[1, 2], [11, 12]]);
        const before = pcmBits(track);
        const node = await overdub(track);

        // The processor has already applied [10, 14); repeated indices model
        // two loop wraps and require reverse-order restoration of old samples.
        node.port.receive({ type: 'OVERDUB_PATCH', sequence: 0, slotIndex: 0, validFrames: 4,
            startInputFrame: 10, endInputFrame: 14,
            indices: new Uint32Array([1, 0, 1, 0]),
            oldValues: new Float32Array([2, 1, 3, 2]), values: new Float32Array([3, 2, 4, 3]),
            oldRightValues: new Float32Array([12, 11, 13, 12]), rightValues: new Float32Array([13, 12, 14, 13]),
        });
        expect(channelsOf(track)).toEqual([[3, 4], [13, 14]]);

        engine.getInputCaptureRequestFrame = () => 12;
        track.triggerRecord();
        expect(node.port.posted.at(-1)).toEqual({ type: 'OVERDUB_STOP', stopFrame: 12 });
        expect(channelsOf(track)).toEqual([[2, 3], [12, 13]]); // [S, 14) is removed.

        // A later post-stop patch is ignored, but remains part of the explicit
        // patchesSent terminal barrier.
        node.port.receive({ type: 'OVERDUB_PATCH', sequence: 1, slotIndex: 1, validFrames: 1,
            startInputFrame: 14, endInputFrame: 15,
            indices: new Uint32Array([1]), oldValues: new Float32Array([3]), values: new Float32Array([99]),
            oldRightValues: new Float32Array([13]), rightValues: new Float32Array([199]),
        });
        node.port.receive({ type: 'OVERDUB_STOPPED', patchesSent: 2, overflowFrames: 0, overflowEvents: 0,
            requestedStopFrame: 12, appliedExclusiveEnd: 12, processorStopFrame: 12 });
        expect(channelsOf(track)).toEqual([[2, 3], [12, 13]]);
        expect(track.undo()).toBe(true);
        expect(pcmBits(track)).toEqual(before);
    });

    it('applies only the pre-stop prefix of a delayed patch before acknowledging the last patch', async () => {
        const { tracks: [track], engine } = createHarness();
        record(track, [[1, 2, 3, 4]]);
        const before = pcmBits(track);
        const node = await overdub(track);

        engine.getInputCaptureRequestFrame = () => 102;
        track.triggerRecord(); // S=102 is exclusive while the processor patch is still in transit.
        node.port.receive({ type: 'OVERDUB_PATCH', sequence: 0, slotIndex: 0, validFrames: 4,
            startInputFrame: 100, endInputFrame: 104,
            indices: new Uint32Array([0, 1, 2, 3]),
            oldValues: new Float32Array([1, 2, 3, 4]), values: new Float32Array([11, 22, 33, 44]),
        });
        expect(channelsOf(track)).toEqual([[11, 22, 3, 4]]);
        node.port.receive({ type: 'OVERDUB_STOPPED', patchesSent: 1, overflowFrames: 0, overflowEvents: 0,
            requestedStopFrame: 102, appliedExclusiveEnd: 102, processorStopFrame: 102 });
        expect(node.disconnected).toBe(true);
        expect(track.canUndo).toBe(true);
        expect(track.undo()).toBe(true);
        expect(pcmBits(track)).toEqual(before);
    });

    it('rolls back and retires the processor when a patch predecessor does not match live PCM', async () => {
        const { tracks: [track] } = createHarness();
        record(track, [[1, 2, 3, 4]]);
        const before = pcmBits(track);
        const historyBefore = { undo: track.canUndo, redo: track.canRedo, bytes: track.historyTotalRetainedBytes };
        const node = await overdub(track);
        patch(track, node, 0, 0, 9, undefined, 100);
        expect(channelsOf(track)).toEqual([[9, 2, 3, 4]]);

        node.port.receive({ type: 'OVERDUB_PATCH', sequence: 1, slotIndex: 1, validFrames: 1,
            startInputFrame: 101, endInputFrame: 102,
            indices: new Uint32Array([1]), oldValues: new Float32Array([99]), values: new Float32Array([10]),
        });
        expect(pcmBits(track)).toEqual(before);
        expect(track.state).toBe(TrackState.PLAYING);
        expect(track.overdubDiagnostic).toContain('the entire edit was rolled back');
        expect(node.port.posted.at(-1)).toMatchObject({ type: 'OVERDUB_STOP' });

        node.port.receive({ type: 'OVERDUB_STOPPED', patchesSent: 2, overflowFrames: 0, overflowEvents: 0,
            requestedStopFrame: 0, appliedExclusiveEnd: 0, processorStopFrame: 0 });
        expect(node.disconnected).toBe(true);
        expect(pcmBits(track)).toEqual(before);
        expect({ undo: track.canUndo, redo: track.canRedo, bytes: track.historyTotalRetainedBytes }).toEqual(historyBefore);
    });

    it('restores the complete pre-overdub PCM and prior history after terminal pool overflow', async () => {
        const { tracks: [track], engine } = createHarness();
        record(track, [[1, 2, 3, 4], [11, 12, 13, 14]]);
        track.clear();
        expect(track.undo()).toBe(true); // Preserve a prior redo entry across failed overdub.
        const before = pcmBits(track);
        const historyBefore = { undo: track.canUndo, redo: track.canRedo, bytes: track.historyTotalRetainedBytes };
        const node = await overdub(track);

        node.port.receive({ type: 'OVERDUB_PATCH', sequence: 0, slotIndex: 0, validFrames: 1,
            startInputFrame: 100, endInputFrame: 101,
            indices: new Uint32Array([0]), values: new Float32Array([9]), oldValues: new Float32Array([1]),
            rightValues: new Float32Array([19]), oldRightValues: new Float32Array([11]),
        });
        expect(channelsOf(track)).toEqual([[9, 2, 3, 4], [19, 12, 13, 14]]);

        engine.getInputCaptureRequestFrame = () => 101;
        track.triggerRecord();
        node.port.receive({ type: 'OVERDUB_STOPPED', patchesSent: 2, overflowFrames: 2, overflowEvents: 1,
            requestedStopFrame: 101, appliedExclusiveEnd: 101, processorStopFrame: 128 });

        expect(pcmBits(track)).toEqual(before);
        expect(track.overdubDiagnostic).toContain('complete edit was rolled back to pre-overdub PCM');
        expect(node.disconnected).toBe(false); // Wait for the terminal patch count after rollback.
        node.port.receive({ type: 'OVERDUB_PATCH', sequence: 1, slotIndex: 1, validFrames: 1,
            startInputFrame: 101, endInputFrame: 102,
            indices: new Uint32Array([1]), values: new Float32Array([20]), oldValues: new Float32Array([2]),
            rightValues: new Float32Array([30]), oldRightValues: new Float32Array([12]),
        });
        expect(node.disconnected).toBe(true);
        expect(pcmBits(track)).toEqual(before); // A patch arriving after rollback cannot reapply partial PCM.
        expect({ undo: track.canUndo, redo: track.canRedo, bytes: track.historyTotalRetainedBytes }).toEqual(historyBefore);
        expect(track.redo()).toBe(true);
        expect(channelsOf(track)).toBeNull();
        expect(track.undo()).toBe(true);
        expect(pcmBits(track)).toEqual(before);
    });

    it('does not report a successful overflow rollback when the baseline image is unavailable', async () => {
        const { tracks: [track], engine } = createHarness();
        record(track, [[1, 2, 3, 4], [11, 12, 13, 14]]);
        const before = pcmBits(track);
        const node = await overdub(track);

        node.port.receive({ type: 'OVERDUB_PATCH', sequence: 0, slotIndex: 0, validFrames: 1,
            startInputFrame: 100, endInputFrame: 101,
            indices: new Uint32Array([0]), values: new Float32Array([9]), oldValues: new Float32Array([1]),
            rightValues: new Float32Array([19]), oldRightValues: new Float32Array([11]),
        });
        // Model an unavailable or incompatible rollback image. The separately
        // reserved history snapshot remains available for the documented Undo
        // fallback, but automatic in-place restoration must fail honestly.
        (track as any).overdubBaselineSnapshot = null;
        engine.getInputCaptureRequestFrame = () => 101;
        track.triggerRecord();
        const stopped = { type: 'OVERDUB_STOPPED', patchesSent: 2, overflowFrames: 1, overflowEvents: 1,
            requestedStopFrame: 101, appliedExclusiveEnd: 101, processorStopFrame: 128 };
        node.port.receive(stopped);
        expect(track.overdubDiagnostic).toContain('automatic PCM restoration failed');
        expect(pcmBits(track)).not.toEqual(before);

        // A duplicate terminal message cannot convert the failed restoration
        // into a false success merely because further patch application was
        // stopped.
        node.port.receive(stopped);
        expect(track.overdubDiagnostic).toContain('automatic PCM restoration failed');
        expect(track.overdubDiagnostic).not.toContain('complete edit was rolled back');
        node.port.receive({ type: 'OVERDUB_PATCH', sequence: 1, slotIndex: 1, validFrames: 1,
            startInputFrame: 101, endInputFrame: 102,
            indices: new Uint32Array([1]), values: new Float32Array([20]), oldValues: new Float32Array([2]),
            rightValues: new Float32Array([30]), oldRightValues: new Float32Array([12]),
        });
        expect(pcmBits(track)).not.toEqual(before); // Later patches are ignored after rollback failure.
        expect(track.undo()).toBe(true);
        expect(pcmBits(track)).toEqual(before);
    });

    it('requires bit-exact patch preimages, including the sign bit of zero', async () => {
        const { tracks: [track] } = createHarness();
        record(track, [[-0, 1]]);
        const before = pcmBits(track);
        const node = await overdub(track);

        // +0 compares numerically equal to the live -0, but accepting it would
        // make rollback overwrite an exact PCM bit with the wrong zero sign.
        node.port.receive({ type: 'OVERDUB_PATCH', sequence: 0, slotIndex: 0, validFrames: 1,
            startInputFrame: 100, endInputFrame: 101,
            indices: new Uint32Array([0]), oldValues: new Float32Array([0]), values: new Float32Array([2]),
        });
        expect(pcmBits(track)).toEqual(before);
        expect(track.overdubDiagnostic).toContain('patch predecessor state was unavailable');

        node.port.receive({ type: 'OVERDUB_STOPPED', patchesSent: 1, overflowFrames: 0, overflowEvents: 0,
            requestedStopFrame: 0, appliedExclusiveEnd: 0, processorStopFrame: 0 });
        expect(node.disconnected).toBe(true);
        expect(track.historyBusy).toBe(false);
        expect(pcmBits(track)).toEqual(before);
    });

    it('rolls back if the terminal ACK reports a processor cutoff different from the requested stop frame', async () => {
        const { tracks: [track], engine } = createHarness();
        record(track, [[1, 2, 3, 4]]);
        const before = pcmBits(track);
        const historyBefore = { undo: track.canUndo, redo: track.canRedo, bytes: track.historyTotalRetainedBytes };
        const node = await overdub(track);
        patch(track, node, 0, 0, 9, undefined, 100);
        engine.getInputCaptureRequestFrame = () => 101;
        track.triggerRecord();

        node.port.receive({ type: 'OVERDUB_STOPPED', patchesSent: 1, overflowFrames: 0, overflowEvents: 0,
            requestedStopFrame: 101, appliedExclusiveEnd: 101, processorStopFrame: 100 });
        expect(node.disconnected).toBe(true);
        expect(pcmBits(track)).toEqual(before);
        expect(track.overdubDiagnostic).toContain('did not confirm the requested stop frame 101');
        expect({ undo: track.canUndo, redo: track.canRedo, bytes: track.historyTotalRetainedBytes }).toEqual(historyBefore);
    });

    it('validates the processor-reported cutoff when the host could not read its own stop frame', async () => {
        const { tracks: [track] } = createHarness();
        record(track, [[1, 2, 3, 4]]);
        const before = pcmBits(track);
        const node = await overdub(track);
        (track as any).getOverdubStopFrame = () => null;

        track.triggerRecord();
        expect(node.port.posted.at(-1)).toEqual({ type: 'OVERDUB_STOP', stopFrame: null });
        node.port.receive({ type: 'OVERDUB_STOPPED', patchesSent: 0, overflowFrames: 0, overflowEvents: 0,
            requestedStopFrame: 17, appliedExclusiveEnd: 17, processorStopFrame: 128 });

        expect(node.disconnected).toBe(true);
        expect(pcmBits(track)).toEqual(before);
        expect(track.overdubDiagnostic).toContain('could not be read from the audio clock');
    });

    it.each([
        ['missing request frame', { appliedExclusiveEnd: 101, processorStopFrame: 101 }],
        ['NaN request frame', { requestedStopFrame: Number.NaN, appliedExclusiveEnd: 101, processorStopFrame: 101 }],
        ['request frame different from the requested boundary', { requestedStopFrame: 100, appliedExclusiveEnd: 101, processorStopFrame: 128 }],
        ['missing exclusive applied end', { requestedStopFrame: 101, processorStopFrame: 101 }],
        ['NaN exclusive applied end', { requestedStopFrame: 101, appliedExclusiveEnd: Number.NaN, processorStopFrame: 101 }],
        ['exclusive applied end different from the requested boundary', { requestedStopFrame: 101, appliedExclusiveEnd: 100, processorStopFrame: 128 }],
        ['missing processor frame', { requestedStopFrame: 101, appliedExclusiveEnd: 101 }],
        ['processor frame before the requested cutoff', { requestedStopFrame: 101, appliedExclusiveEnd: 101, processorStopFrame: 100 }],
    ])('rolls back if the terminal ACK has %s', async (_name, fields) => {
        const { tracks: [track], engine } = createHarness();
        record(track, [[1, 2, 3, 4]]);
        const before = pcmBits(track);
        const historyBefore = { undo: track.canUndo, redo: track.canRedo, bytes: track.historyTotalRetainedBytes };
        const node = await overdub(track);
        patch(track, node, 0, 0, 9, undefined, 100);
        engine.getInputCaptureRequestFrame = () => 101;
        track.triggerRecord();

        node.port.receive({ type: 'OVERDUB_STOPPED', patchesSent: 1, overflowFrames: 0, overflowEvents: 0, ...fields });
        expect(node.disconnected).toBe(true);
        expect(pcmBits(track)).toEqual(before);
        expect(track.overdubDiagnostic).toContain('did not confirm the requested stop frame 101 and exclusive PCM boundary');
        expect({ undo: track.canUndo, redo: track.canRedo, bytes: track.historyTotalRetainedBytes }).toEqual(historyBefore);
    });

    it.each([
        ['missing patchesSent', { patchesSent: undefined }],
        ['NaN patchesSent', { patchesSent: Number.NaN }],
        ['fractional patchesSent', { patchesSent: 0.5 }],
        ['infinite patchesSent', { patchesSent: Number.POSITIVE_INFINITY }],
        ['negative patchesSent', { patchesSent: -1 }],
        ['missing overflowFrames', { overflowFrames: undefined }],
        ['NaN overflowFrames', { overflowFrames: Number.NaN }],
        ['negative overflowFrames', { overflowFrames: -1 }],
        ['missing overflowEvents', { overflowEvents: undefined }],
        ['NaN overflowEvents', { overflowEvents: Number.NaN }],
        ['patch count below already delivered messages', { patchesSent: 0 }],
    ])('rolls back if the terminal ACK has invalid counters: %s', async (_name, counters) => {
        const { tracks: [track], engine } = createHarness();
        record(track, [[1, 2, 3, 4]]);
        const before = pcmBits(track);
        const historyBefore = { undo: track.canUndo, redo: track.canRedo, bytes: track.historyTotalRetainedBytes };
        const node = await overdub(track);
        patch(track, node, 0, 0, 9, undefined, 100);
        engine.getInputCaptureRequestFrame = () => 101;
        track.triggerRecord();

        node.port.receive({ type: 'OVERDUB_STOPPED', patchesSent: 1, overflowFrames: 0, overflowEvents: 0,
            requestedStopFrame: 101, appliedExclusiveEnd: 101, processorStopFrame: 128, ...counters });
        expect(node.disconnected).toBe(true);
        expect(pcmBits(track)).toEqual(before);
        expect(track.overdubDiagnostic).toContain('invalid terminal patch-count or overflow acknowledgement');
        expect({ undo: track.canUndo, redo: track.canRedo, bytes: track.historyTotalRetainedBytes }).toEqual(historyBefore);
    });

    it('keeps prior history when a skipped patch sequence is followed by an invalid stop ACK', async () => {
        const { tracks: [track], engine } = createHarness();
        record(track, [[1, 2, 3, 4]]);
        const before = pcmBits(track);
        const historyBefore = { undo: track.canUndo, redo: track.canRedo, bytes: track.historyTotalRetainedBytes };
        const node = await overdub(track);
        engine.getInputCaptureRequestFrame = () => 101;

        node.port.receive({ type: 'OVERDUB_PATCH', sequence: 1, slotIndex: 0, validFrames: 1,
            startInputFrame: 100, endInputFrame: 101,
            indices: new Uint32Array([0]), oldValues: new Float32Array([1]), values: new Float32Array([9]),
        });
        expect(pcmBits(track)).toEqual(before);
        expect(track.overdubDiagnostic).toContain('arrived out of sequence');

        node.port.receive({ type: 'OVERDUB_STOPPED', patchesSent: 1, overflowFrames: 0, overflowEvents: 0,
            requestedStopFrame: 100, appliedExclusiveEnd: 100, processorStopFrame: 128 });
        expect(node.disconnected).toBe(true);
        expect(pcmBits(track)).toEqual(before);
        expect({ undo: track.canUndo, redo: track.canRedo, bytes: track.historyTotalRetainedBytes }).toEqual(historyBefore);
    });

    it('stages exact shared-input frames before any PCM patch, then commits one undoable stereo edit', async () => {
        const { engine, tracks: [track] } = createHarness();
        record(track, [[0.125, 0.25, 0.5, 1], [-0.125, -0.25, -0.5, -1]]);
        const before = pcmBits(track);
        const capture = installSharedCapture(engine);
        const node = await overdub(track);
        const init = node.port.posted.find(({ type }) => type === 'OVERDUB_INIT');
        expect(init).toMatchObject({ requestFrame: 100, channelCount: 2 });

        // The input tap's format ACK may arrive before the new overdub worklet's
        // first active frame. It must be retained, not treated as a protocol error.
        capture.send({ type: 'RECORD_CONFIGURED', sessionId: 73, inputGeneration: 4,
            requestedStartFrame: 100, channelCount: 2, maxRecordingFrames: 8_192, maxRecordingBytes: 384 * 1024 * 1024 });
        node.port.receive({ type: 'OVERDUB_FIRST_INPUT_FRAME', requestFrame: 100, firstInputFrame: 102, channelCount: 2 });
        expect(engine.stopInputCaptureSession).toHaveBeenCalledWith(capture.session, 102);

        const left = new Float32Array(16_384);
        const right = new Float32Array(16_384);
        left.set([0.0625, 0.125]);
        right.set([-0.0625, -0.125]);
        capture.send({ type: 'RECORD_CHUNK', sessionId: 73, inputGeneration: 4, chunkIndex: 0,
            sequence: 0, validFrames: 2, channelCount: 2, startFrame: 100, channels: [left, right] });
        capture.send({ type: 'RECORD_COMPLETE', sessionId: 73, inputGeneration: 4,
            requestedStartFrame: 100, stopFrame: 102, framesCaptured: 2, droppedFrames: 0,
            overflowEvents: 0, maxRecordingFrames: 8_192, maxRecordingBytes: 384 * 1024 * 1024,
            channelCount: 2, limitReached: false, chunksSent: 1, status: 'complete' });

        const backfill = node.port.posted.find(({ type }) => type === 'OVERDUB_BACKFILL');
        expect(backfill).toBeDefined();
        expect(backfill).toMatchObject({ requestFrame: 100, firstInputFrame: 102, validFrames: 2, channelCount: 2 });
        expect(Array.from(backfill.channels[0].slice(0, 2))).toEqual([0.0625, 0.125]);
        expect(Array.from(backfill.channels[1].slice(0, 2))).toEqual([-0.0625, -0.125]);
        expect(pcmBits(track)).toEqual(before); // Private startup staging has not edited shared AudioBuffer PCM.
        expect(engine.releaseInputCaptureSession).toHaveBeenCalledWith(capture.session);

        node.port.receive({ type: 'OVERDUB_PATCH', sequence: 0, slotIndex: 0, validFrames: 1,
            startInputFrame: 100, endInputFrame: 101,
            indices: new Uint32Array([0]), values: new Float32Array([0.1875]),
            oldValues: new Float32Array([0.125]), rightValues: new Float32Array([-0.1875]),
            oldRightValues: new Float32Array([-0.125]) });
        finishOverdub(track, node, 1);
        expect(channelsOf(track)).toEqual([[0.1875, 0.25, 0.5, 1], [-0.1875, -0.25, -0.5, -1]]);
        expect(track.undo()).toBe(true);
        expect(pcmBits(track)).toEqual(before);
    });

    it('accepts a zero-length backfill ACK after the tap has negotiated the same stereo format', async () => {
        const { engine, tracks: [track] } = createHarness();
        record(track, [[0.125, 0.25, 0.5, 1], [-0.125, -0.25, -0.5, -1]]);
        const before = pcmBits(track);
        const capture = installSharedCapture(engine);
        const node = await overdub(track);
        capture.send({ type: 'RECORD_CONFIGURED', sessionId: 73, inputGeneration: 4,
            requestedStartFrame: 100, channelCount: 2, maxRecordingFrames: 8_192, maxRecordingBytes: 384 * 1024 * 1024 });
        node.port.receive({ type: 'OVERDUB_FIRST_INPUT_FRAME', requestFrame: 100, firstInputFrame: 100, channelCount: 2 });
        capture.send({ type: 'RECORD_COMPLETE', sessionId: 73, inputGeneration: 4,
            requestedStartFrame: 100, stopFrame: 100, framesCaptured: 0, droppedFrames: 0,
            overflowEvents: 0, maxRecordingFrames: 8_192, maxRecordingBytes: 384 * 1024 * 1024,
            channelCount: 2, limitReached: false, chunksSent: 0, status: 'complete' });

        const backfill = node.port.posted.find(({ type }) => type === 'OVERDUB_BACKFILL');
        expect(backfill).toBeDefined();
        expect(backfill).toMatchObject({ requestFrame: 100, firstInputFrame: 100, validFrames: 0, channelCount: 2 });
        expect(pcmBits(track)).toEqual(before);
        expect(engine.releaseInputCaptureSession).toHaveBeenCalledWith(capture.session);
    });

    it('rejects an incomplete shared-input acknowledgement without changing PCM or history', async () => {
        const { engine, tracks: [track] } = createHarness();
        record(track, [[0.125, 0.25, 0.5, 1], [-0.125, -0.25, -0.5, -1]]);
        const before = pcmBits(track);
        const undoBefore = track.canUndo;
        const capture = installSharedCapture(engine);
        const node = await overdub(track);
        capture.send({ type: 'RECORD_CONFIGURED', sessionId: 73, inputGeneration: 4,
            requestedStartFrame: 100, channelCount: 2, maxRecordingFrames: 8_192, maxRecordingBytes: 384 * 1024 * 1024 });
        node.port.receive({ type: 'OVERDUB_FIRST_INPUT_FRAME', requestFrame: 100, firstInputFrame: 102, channelCount: 2 });
        capture.send({ type: 'RECORD_COMPLETE', sessionId: 73, inputGeneration: 4,
            requestedStartFrame: 100, stopFrame: 102, framesCaptured: 1, droppedFrames: 1,
            overflowEvents: 1, maxRecordingFrames: 8_192, maxRecordingBytes: 384 * 1024 * 1024,
            channelCount: 2, limitReached: true, chunksSent: 0, status: 'incomplete' });
        node.port.receive({ type: 'OVERDUB_ERROR', message: 'startup backfill was incomplete' });

        expect((track as any).overdubProcessor).toBe(node);
        expect(track.historyBusy).toBe(true);
        node.port.receive({ type: 'OVERDUB_STOPPED', patchesSent: 0, overflowFrames: 0, overflowEvents: 0, startupCancelled: true });

        expect(node.port.posted.some(({ type }) => type === 'OVERDUB_BACKFILL_ERROR')).toBe(true);
        expect(node.port.posted.some(({ type }) => type === 'OVERDUB_BACKFILL')).toBe(false);
        expect(pcmBits(track)).toEqual(before);
        expect(track.canUndo).toBe(undoBefore);
        expect(engine.releaseInputCaptureSession).toHaveBeenCalledWith(capture.session);
    });

    it('waits for input-capture abort acknowledgement before releasing a startup lease', async () => {
        const { engine, tracks: [track] } = createHarness();
        record(track, [[0.125, 0.25, 0.5, 1]]);
        const before = pcmBits(track);
        const capture = installSharedCapture(engine);
        const node = await overdub(track);

        track.triggerRecord(); // Cancels before the first startup patch.
        expect(engine.abortInputCaptureSession).toHaveBeenCalledWith(capture.session);
        expect(engine.releaseInputCaptureSession).not.toHaveBeenCalled();
        node.port.receive({ type: 'OVERDUB_STOPPED', patchesSent: 0, overflowFrames: 0, overflowEvents: 0,
            startupCancelled: true });
        const pending = new Float32Array(16_384);
        capture.send({ type: 'RECORD_CHUNK', sessionId: 73, inputGeneration: 4, chunkIndex: 0,
            sequence: 0, validFrames: 1, channelCount: 1, startFrame: 100, channels: [pending] });
        expect(engine.recycleInputCaptureChunk).toHaveBeenCalledWith(capture.session, 0, [pending]);
        capture.send({ type: 'RECORD_ABORTED', sessionId: 73, inputGeneration: 4, chunksSent: 1 });

        expect(engine.releaseInputCaptureSession).toHaveBeenCalledWith(capture.session);
        expect(pcmBits(track)).toEqual(before);
    });

    it('does not abort an already-stopped capture while its exact completion ACK is in flight', async () => {
        const { engine, tracks: [track] } = createHarness();
        record(track, [[0.125, 0.25, 0.5, 1]]);
        const before = pcmBits(track);
        const capture = installSharedCapture(engine);
        const node = await overdub(track);
        node.port.receive({ type: 'OVERDUB_FIRST_INPUT_FRAME', requestFrame: 100, firstInputFrame: 102, channelCount: 1 });
        expect(engine.stopInputCaptureSession).toHaveBeenCalledWith(capture.session, 102);

        track.triggerRecord(); // User cancels after STOP_CAPTURE was accepted but before RECORD_COMPLETE arrives.
        expect(engine.abortInputCaptureSession).not.toHaveBeenCalled();
        expect(engine.releaseInputCaptureSession).not.toHaveBeenCalled();
        node.port.receive({ type: 'OVERDUB_STOPPED', patchesSent: 0, overflowFrames: 0, overflowEvents: 0,
            startupCancelled: true });
        capture.send({ type: 'RECORD_COMPLETE', sessionId: 73, inputGeneration: 4,
            requestedStartFrame: 100, stopFrame: 102, framesCaptured: 2, droppedFrames: 0,
            overflowEvents: 0, maxRecordingFrames: 8_192, maxRecordingBytes: 384 * 1024 * 1024,
            channelCount: 1, limitReached: false, chunksSent: 0, status: 'complete' });

        expect(engine.releaseInputCaptureSession).toHaveBeenCalledWith(capture.session);
        expect(pcmBits(track)).toEqual(before);
    });

    it('invalidates only the edited track redo on a new completed recording', () => {
        const { tracks: [first, second] } = createHarness();
        record(first, [[1, 2, 3, 4]]);
        record(second, [[5, 6, 7, 8]]);
        first.undo();
        second.undo();
        expect(first.canRedo).toBe(true);
        record(first, [[21, 22, 23, 24]]);
        expect(first.canRedo).toBe(false);
        expect(first.redo()).toBe(false);
        expect(second.canRedo).toBe(true);
        first.undo();
        first.redo();
        expect(channelsOf(first)).toEqual([[21, 22, 23, 24]]);
    });

    it('invalidates redo on the first actual overdub patch, but a no-input session preserves it', async () => {
        const { tracks: [track] } = createHarness();
        record(track, [[1, 2, 3, 4], [11, 12, 13, 14]]);
        track.clear();
        track.undo(); // Live loop, redo would clear it.
        const noInput = await overdub(track);
        finishOverdub(track, noInput, 0);
        expect(track.canRedo).toBe(true);
        const edited = await overdub(track);
        patch(track, edited, 0, 0, 44, 144);
        finishOverdub(track, edited, 1);
        expect(track.canRedo).toBe(false);
        expect(track.undo()).toBe(true);
        expect(channelsOf(track)).toEqual([[1, 2, 3, 4], [11, 12, 13, 14]]);
    });

    it('rejects overdub before PCM mutation if its rollback snapshot cannot be allocated', async () => {
        const { context, tracks: [track] } = createHarness();
        record(track, [[1, 2, 3, 4]]);
        track.clear();
        track.undo();
        vi.spyOn(context, 'createBuffer').mockImplementationOnce(() => { throw new RangeError('out of memory'); });
        const before = pcmBits(track);
        const historyBefore = { undo: track.canUndo, redo: track.canRedo, bytes: track.historyTotalRetainedBytes };
        track.state = TrackState.PLAYING;
        track.triggerRecord();
        await settle();
        expect(FakeWorklet.instances).toHaveLength(0);
        expect(track.state).toBe(TrackState.PLAYING);
        expect(pcmBits(track)).toEqual(before);
        expect({ undo: track.canUndo, redo: track.canRedo, bytes: track.historyTotalRetainedBytes }).toEqual(historyBefore);
        expect(track.historyUnavailableReason).toContain('could not allocate');
        expect(track.overdubDiagnostic).toContain('could not allocate');
    });

    it('restores its old master timing only when no current master would be overwritten', () => {
        const { tracks: [first, second], transport } = createHarness();
        record(first, [[1, 2, 3, 4]]);
        transport.setBpm(93);
        transport.measureLength = 2.58;
        first.clear();
        expect(transport.hasMasterTrack()).toBe(false);
        first.undo();
        expect(transport.masterTrackId).toBe(1);
        expect(transport.bpm).toBe(93);
        expect(transport.measureLength).toBe(2.58);
        first.redo();
        record(second, [[5, 6, 7, 8]]);
        transport.setBpm(137);
        first.undo();
        expect(transport.masterTrackId).toBe(2);
        expect(transport.bpm).toBe(137);
    });
});

describe('Browser PCM history asynchronous barriers', () => {
    it('discards a shared take after stop ACK timeout and fences a late ACK from a later session', async () => {
        const { context, tracks: [track], engine } = createHarness();
        record(track, [[0.125, -0, 0.75], [-0.5, 0.25, 0.375]]);
        record(track, [[0.25, -0, -0.75], [0.5, -0.25, -0.375]]);
        const incumbent = pcmBits(track);
        const historyBefore = { undo: track.canUndo, redo: track.canRedo, bytes: track.historyTotalRetainedBytes };
        const sharedEngine = engine as any;
        const sessions: InputCaptureSession[] = [];
        const listeners = new Map<number, (message: unknown) => void>();
        let nextStartFrame = 100;
        sharedEngine.getInputCaptureRequestFrame = vi.fn(() => nextStartFrame);
        sharedEngine.beginInputCaptureSession = vi.fn((trackIndex: number, startFrame: number, listener: (message: unknown) => void) => {
            const node = new FakeWorklet(context, 'shared-input-capture') as unknown as AudioWorkletNode;
            const session: InputCaptureSession = {
                node, trackIndex, sessionId: 72 + sessions.length, inputGeneration: 4, startFrame,
            };
            sessions.push(session);
            listeners.set(session.sessionId, listener);
            return session;
        });
        sharedEngine.stopInputCaptureSession = vi.fn(() => true);
        sharedEngine.abortInputCaptureSession = vi.fn();
        sharedEngine.recycleInputCaptureChunk = vi.fn(() => true);
        sharedEngine.releaseInputCaptureSession = vi.fn();

        vi.useFakeTimers();
        try {
            await track.startRecording();
            const staleSession = sessions[0]!;
            const staleListener = listeners.get(staleSession.sessionId)!;
            expect(track.recordingCaptureSession).toBe(staleSession);
            await track.stopRecording();
            expect(track.historyBusy).toBe(true);
            expect(sharedEngine.stopInputCaptureSession).toHaveBeenCalledWith(staleSession, 100);

            (context as unknown as { state: AudioContextState }).state = 'suspended';
            await vi.advanceTimersByTimeAsync(5_000);
            expect(track.historyBusy).toBe(false);
            expect(track.state).toBe(TrackState.STOPPED);
            expect(track.recordingCaptureSession).toBeNull();
            expect(track.recordingDiagnostic).toContain('AudioContext state: suspended');
            expect(track.recordingDiagnostic).toContain('incomplete take was discarded');
            expect(sharedEngine.abortInputCaptureSession).toHaveBeenCalledWith(staleSession);
            expect(sharedEngine.releaseInputCaptureSession).toHaveBeenCalledWith(staleSession);
            expect(pcmBits(track)).toEqual(incumbent);
            expect({ undo: track.canUndo, redo: track.canRedo, bytes: track.historyTotalRetainedBytes }).toEqual(historyBefore);

            // A delayed completion from the abandoned session must not finish or
            // mutate a newly-started take, even when it arrives before its ACK.
            (context as unknown as { state: AudioContextState }).state = 'running';
            nextStartFrame = 200;
            await track.startRecording();
            const currentSession = sessions[1]!;
            expect(currentSession.sessionId).not.toBe(staleSession.sessionId);
            expect(track.recordingCaptureSession).toBe(currentSession);
            staleListener({
                type: 'RECORD_COMPLETE', sessionId: staleSession.sessionId, inputGeneration: staleSession.inputGeneration,
                requestedStartFrame: staleSession.startFrame, stopFrame: staleSession.startFrame,
                framesCaptured: 0, droppedFrames: 0, overflowEvents: 0, maxRecordingFrames: 8_192,
                limitReached: false, chunksSent: 0,
            });
            expect(track.historyBusy).toBe(true);
            expect(track.recordingCaptureSession).toBe(currentSession);
            expect(pcmBits(track)).toEqual(incumbent);

            await track.stopRecording();
            listeners.get(currentSession.sessionId)?.({
                type: 'RECORD_COMPLETE', sessionId: currentSession.sessionId, inputGeneration: currentSession.inputGeneration,
                requestedStartFrame: currentSession.startFrame, stopFrame: currentSession.startFrame,
                framesCaptured: 0, droppedFrames: 0, overflowEvents: 0, maxRecordingFrames: 8_192,
                limitReached: false, chunksSent: 0,
            });
            expect(track.historyBusy).toBe(false);
            expect(pcmBits(track)).toEqual(incumbent);
            expect({ undo: track.canUndo, redo: track.canRedo, bytes: track.historyTotalRetainedBytes }).toEqual(historyBefore);
            await vi.advanceTimersByTimeAsync(5_000);
            expect(sharedEngine.abortInputCaptureSession).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it('keeps the reserved undo image when terminal stop ACK times out after a pre-stop patch', async () => {
        const { tracks: [track], engine } = createHarness();
        record(track, [[1, 2, 3, 4], [11, 12, 13, 14]]);
        const before = pcmBits(track);
        const node = await overdub(track);
        patch(track, node, 0, 1, 22, 122, 100);
        engine.getInputCaptureRequestFrame = () => 101;

        vi.useFakeTimers();
        try {
            track.triggerRecord();
            expect(channelsOf(track)).toEqual([[1, 22, 3, 4], [11, 122, 13, 14]]);
            await vi.advanceTimersByTimeAsync(5_000);
            expect(node.disconnected).toBe(true);
            expect(track.overdubDiagnostic).toContain('missing pre-stop patches may leave a partial overdub');
            expect(track.canUndo).toBe(true);
            expect(track.undo()).toBe(true);
            expect(pcmBits(track)).toEqual(before);
        } finally {
            vi.useRealTimers();
        }
    });

    it('unlocks history after automatic capture-limit completion without a control-thread stop', async () => {
        const { tracks: [track] } = createHarness();
        await track.startRecording();
        const node = FakeWorklet.instances.at(-1)!;
        (track as any).resumeAfterRecording = false;
        node.port.receive({ type: 'RECORD_CHUNK', sequence: 0, chunkIndex: 0, validFrames: 4, channelCount: 2,
            channels: [new Float32Array([1, 2, 3, 4]), new Float32Array([11, 12, 13, 14])] });
        node.port.receive({ type: 'RECORD_COMPLETE', framesCaptured: 4, droppedFrames: 1, overflowEvents: 0,
            channelCount: 2, maxRecordingFrames: 4, limitReached: true, chunksSent: 1 });
        expect(track.historyBusy).toBe(false);
        expect(track.recordingLimitReached).toBe(true);
        expect(track.recordingDiagnostic).toContain('capacity reached');
        expect(track.undo()).toBe(true);
        expect(track.redo()).toBe(true);
        expect(channelsOf(track)).toEqual([[1, 2, 3, 4], [11, 12, 13, 14]]);
    });

    it('keeps both captured channels if the completion acknowledgement misreports mono', async () => {
        const { tracks: [track] } = createHarness();
        await track.startRecording();
        const node = FakeWorklet.instances.at(-1)!;
        (track as any).resumeAfterRecording = false;
        node.port.receive({ type: 'RECORD_CHUNK', sequence: 0, chunkIndex: 0, validFrames: 4, channelCount: 2,
            channels: [new Float32Array([1, 2, 3, 4]), new Float32Array([11, 12, 13, 14])] });
        node.port.receive({ type: 'RECORD_COMPLETE', framesCaptured: 4, droppedFrames: 0, overflowEvents: 0,
            channelCount: 1, maxRecordingFrames: 4, limitReached: false, chunksSent: 1 });
        expect(channelsOf(track)).toEqual([[1, 2, 3, 4], [11, 12, 13, 14]]);
        expect(track.recordingDiagnostic).toContain('all captured channels were preserved');
        expect(track.undo()).toBe(true);
        expect(track.redo()).toBe(true);
        expect(channelsOf(track)).toEqual([[1, 2, 3, 4], [11, 12, 13, 14]]);
    });

    it('waits for every record chunk before publishing an undoable stereo recording', async () => {
        const { tracks: [track] } = createHarness();
        await track.startRecording();
        const node = FakeWorklet.instances.at(-1)!;
        await track.stopRecording();
        (track as any).resumeAfterRecording = false;
        node.port.receive({ type: 'RECORD_COMPLETE', framesCaptured: 4, droppedFrames: 0, overflowEvents: 0,
            channelCount: 2, maxRecordingFrames: 4, limitReached: false, chunksSent: 2 });
        expect(track.historyBusy).toBe(true);
        expect(track.undo()).toBe(false);
        node.port.receive({ type: 'RECORD_CHUNK', sequence: 1, chunkIndex: 1, validFrames: 2, channelCount: 2,
            channels: [new Float32Array([3, 4]), new Float32Array([13, 14])] });
        expect(bufferOf(track)).toBeNull();
        node.port.receive({ type: 'RECORD_CHUNK', sequence: 0, chunkIndex: 0, validFrames: 2, channelCount: 2,
            channels: [new Float32Array([1, 2]), new Float32Array([11, 12])] });
        expect(channelsOf(track)).toEqual([[1, 2, 3, 4], [11, 12, 13, 14]]);
        expect(track.historyBusy).toBe(false);
        expect(track.canUndo).toBe(true);
        expect(track.undo()).toBe(true);
        expect(track.state).toBe(TrackState.EMPTY);
        expect(track.redo()).toBe(true);
        expect(channelsOf(track)).toEqual([[1, 2, 3, 4], [11, 12, 13, 14]]);
    });

    it('ignores queued recording completion/chunks after clear and keeps the existing redo', async () => {
        const { tracks: [track] } = createHarness();
        record(track, [[1, 2, 3, 4], [11, 12, 13, 14]]);
        track.undo();
        await track.startRecording();
        const node = FakeWorklet.instances.at(-1)!;
        const staleCallback = node.port.onmessage!;
        await track.stopRecording();
        node.port.receive({ type: 'RECORD_COMPLETE', framesCaptured: 1, chunksSent: 1, channelCount: 2 });
        expect(track.clear()).toBe(true);
        staleCallback({ data: { type: 'RECORD_CHUNK', sequence: 0, chunkIndex: 0, validFrames: 1, channelCount: 2,
            channels: [new Float32Array([99]), new Float32Array([199])] } });
        staleCallback({ data: { type: 'RECORD_COMPLETE', framesCaptured: 1, chunksSent: 1, channelCount: 2 } });
        expect(bufferOf(track)).toBeNull();
        expect(track.state).toBe(TrackState.EMPTY);
        expect(track.historyBusy).toBe(false);
        expect(track.redo()).toBe(true);
        expect(channelsOf(track)).toEqual([[1, 2, 3, 4], [11, 12, 13, 14]]);
    });

    it('cancels an awaited recording startup on clear, without reviving the track', async () => {
        const { context, engine, tracks: [track] } = createHarness();
        let release!: (input: AudioNode) => void;
        engine.getProcessedInputNode.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
        const starting = track.startRecording();
        expect(track.historyBusy).toBe(true);
        expect(track.clear()).toBe(true);
        release(context.createGain());
        await starting;
        expect(FakeWorklet.instances).toHaveLength(0);
        expect(track.state).toBe(TrackState.EMPTY);
        expect(track.historyBusy).toBe(false);
    });

    it('drains final overdub patches before clear, then restores the exact final stereo edit', async () => {
        const { tracks: [track], input, engine } = createHarness();
        const disconnected = vi.spyOn(input, 'disconnect');
        record(track, [[1, 2, 3, 4], [11, 12, 13, 14]]);
        const node = await overdub(track);
        const staleCallback = node.port.onmessage!;
        patch(track, node, 0, 0, 21, 121);
        engine.getInputCaptureRequestFrame = () => 102; // Both [100, 101] input frames precede the exclusive stop boundary.
        expect(track.clear()).toBe(true);
        expect(track.historyBusy).toBe(true);
        expect(bufferOf(track)).not.toBeNull();
        expect(track.undo()).toBe(false);
        // The real worklet's MessagePort is FIFO. Deliberately reverse delivery
        // here to verify the explicit patchesSent barrier as well.
        node.port.receive({ type: 'OVERDUB_STOPPED', patchesSent: 2, overflowFrames: 0, overflowEvents: 0,
            requestedStopFrame: 102, appliedExclusiveEnd: 102, processorStopFrame: 102 });
        expect(node.disconnected).toBe(false);
        patch(track, node, 1, 3, 24, 124, 101);
        expect(track.state).toBe(TrackState.EMPTY);
        expect(track.historyBusy).toBe(false);
        expect(node.disconnected).toBe(true);
        expect(disconnected).toHaveBeenCalledWith(node);
        expect(track.historyRetainedBytes).toBe(32);
        expect(track.undo()).toBe(true);
        expect(channelsOf(track)).toEqual([[21, 2, 3, 24], [121, 12, 13, 124]]);
        staleCallback({ data: { type: 'OVERDUB_PATCH', sequence: 2, slotIndex: 0, validFrames: 1,
            indices: new Uint32Array([1]), values: new Float32Array([999]), rightValues: new Float32Array([1999]) } });
        expect(channelsOf(track)).toEqual([[21, 2, 3, 24], [121, 12, 13, 124]]);
    });

    it('ignores a stale patch callback from a retired overdub generation while the next edit is active', async () => {
        const { tracks: [track] } = createHarness();
        record(track, [[1, 2, 3, 4]]);
        const first = await overdub(track);
        const staleCallback = first.port.onmessage!;
        finishOverdub(track, first, 0);
        expect(first.disconnected).toBe(true);

        const second = await overdub(track);
        const beforeStaleMessage = pcmBits(track);
        staleCallback({ data: { type: 'OVERDUB_PATCH', sequence: 0, slotIndex: 0, validFrames: 1,
            startInputFrame: 100, endInputFrame: 101,
            indices: new Uint32Array([0]), oldValues: new Float32Array([1]), values: new Float32Array([999]),
        } });
        expect(pcmBits(track)).toEqual(beforeStaleMessage);
        expect(second.disconnected).toBe(false);
        expect(track.state).toBe(TrackState.OVERDUBBING);
        finishOverdub(track, second, 0);
    });

    it('cancels overdub startup when clear wins the input-await race', async () => {
        const { context, engine, tracks: [track] } = createHarness();
        record(track, [[1, 2, 3, 4], [11, 12, 13, 14]]);
        let release!: (input: AudioNode) => void;
        engine.getProcessedInputNode.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
        track.state = TrackState.PLAYING;
        track.triggerRecord();
        expect(track.clear()).toBe(true);
        release(context.createGain());
        await settle();
        expect(FakeWorklet.instances).toHaveLength(0);
        expect(track.state).toBe(TrackState.EMPTY);
        expect(track.undo()).toBe(true);
        expect(channelsOf(track)).toEqual([[1, 2, 3, 4], [11, 12, 13, 14]]);
    });
});


describe('record/play runtime settings', () => {
    beforeEach(() => { Transport.getInstance().resetMasterTrack(); });
    afterEach(() => { Transport.getInstance().stop(); Transport.getInstance().resetMasterTrack(); });
    it('OFF and MEASURE both align completed slave PCM to the established measure', () => {
        const harness = createHarness();
        const [master, slave] = harness.tracks;
        master!.track.loopSyncSw = 'ON';
        slave!.track.loopSyncSw = 'ON';
        record(master!, [[0.1, 0.2, 0.3, 0.4]]);
        (harness.engine as any).getRecordPlaySettings = () => ({quantize:'OFF', recAction:'REC->PLAY'});
        record(slave!, [[0.5, 0.6, 0.7]]);
        expect(bufferOf(slave!)!.length).toBe(4);
        (harness.engine as any).getRecordPlaySettings = () => ({quantize:'MEASURE', recAction:'REC->PLAY'});
        record(slave!, [[0.5, 0.6, 0.7]]);
        expect(bufferOf(slave!)!.length).toBe(4);
        Object.defineProperty(harness.context, 'state', { value: 'closed' });
        harness.tracks.forEach(track => track.dispose());
    });
    it('OFF starts immediately while MEASURE waits for the established grid', () => {
        const harness = createHarness();
        const [master, slave] = harness.tracks;
        master!.track.loopSyncSw = 'ON';
        slave!.track.loopSyncSw = 'ON';
        record(master!, [[0.1, 0.2, 0.3, 0.4]]);
        const startRecording = vi.spyOn(slave!, 'startRecording').mockResolvedValue(undefined);
        (harness.engine as any).getRecordPlaySettings = () => ({quantize:'OFF', recAction:'REC->PLAY'});
        (slave as any).scheduleRecordingStart();
        expect(startRecording).toHaveBeenCalledOnce();
        startRecording.mockClear();
        (harness.engine as any).getRecordPlaySettings = () => ({quantize:'MEASURE', recAction:'REC->PLAY'});
        (slave as any).scheduleRecordingStart();
        expect(startRecording).not.toHaveBeenCalled();
        expect(slave!.state).toBe(TrackState.REC_STANDBY);
        slave!.triggerStop();
        Object.defineProperty(harness.context, 'state', {value:'closed'});
        harness.tracks.forEach(track => track.dispose());
    });
    it('REC DUB enters the existing overdub provider after recorded PCM publication', async () => {
        const harness = createHarness(undefined, 1);
        const track = harness.tracks[0]!;
        (harness.engine as any).getRecordPlaySettings = () => ({quantize:'OFF', recAction:'REC->DUB'});
        const startOverdub = vi.fn();
        (track as any).startOverdub = startOverdub;
        vi.spyOn(track, 'play').mockImplementation(() => { track.state = TrackState.PLAYING; });
        (track as any).processRecordedBuffers([Float32Array.of(0.1,0.2,0.3,0.4)]);
        await settle();
        expect(bufferOf(track)!.length).toBe(4);
        expect(track.state).toBe(TrackState.OVERDUBBING);
        expect(startOverdub).toHaveBeenCalledOnce();
        Object.defineProperty(harness.context, 'state', { value: 'closed' });
        track.dispose();
    });
});
