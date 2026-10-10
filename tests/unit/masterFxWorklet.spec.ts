import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BrowserFxMidiQueueWriter, createBrowserFxMidiBuffer } from '../../src/audio/browserFxMidiProtocol';

type TestProcessor = {
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
  handleMessage(message: Record<string, unknown>): void;
  processFailures: number;
  nonFiniteSamples: number;
  wetGain: number;
  wetTarget: number;
  wetStep: number;
  wetRampRemaining: number;
  primeFxHandles(handles: number[], warmupFrames: number, ordinals?: number[], midiCapable?: boolean[]): boolean;
  fxTransitionControl: Int32Array | null;
  fxTransitionIndex: number;
  dsp: Record<string, any>;
};

function makeMasterProcessor() {
  let Registered: (new () => object) | null = null;
  const messages: Array<Record<string, unknown>> = [];
  const scope: Record<string, any> = {
    AudioWorkletProcessor: class { port = { postMessage(message: Record<string, unknown>) { messages.push(message); } }; },
    registerProcessor(_name: string, processor: new () => object) { Registered = processor; },
    SharedArrayBuffer,
    Int32Array,
    Float32Array,
    Atomics,
    Math,
    Number,
    sampleRate: 48_000,
    currentFrame: 0,
  };
  const source = readFileSync(resolve(process.cwd(), 'public/worklets/master-fx-processor.js'), 'utf8');
  runInNewContext(source, scope);
  if (!Registered) throw new Error('The master FX Worklet did not register.');
  const processor = Object.create((Registered as new () => object).prototype) as TestProcessor;
  Object.assign(processor, {
    port: { postMessage(message: Record<string, unknown>) { messages.push(message); } },
    processCallbacks: 0, processedFrames: 0, outputFrames: 0, processFailures: 0, nonFiniteSamples: 0,
    lastFrameEnd: -1, lastFrameStart: -1, lastQuantumFrames: 0, minimumQuantumFrames: 0, maximumQuantumFrames: 0,
    frameDiscontinuities: 0, wetGain: 1, wetTarget: 1, wetStep: 0, wetRampRemaining: 0,
    fxTransitionControl: null, fxTransitionIndex: 1, lastFinalizedStageId: 0,
  });

  const maxFrames = 64;
  const memory = new ArrayBuffer(16_384);
  const stride = maxFrames * Float32Array.BYTES_PER_ELEMENT;
  const addresses = {
    leftAAddress: 0, rightAAddress: stride,
    leftBAddress: stride * 2, rightBAddress: stride * 3,
    dryLeftAddress: stride * 4, dryRightAddress: stride * 5,
    oldLeftAAddress: stride * 6, oldRightAAddress: stride * 7,
    oldLeftBAddress: stride * 8, oldRightBAddress: stride * 9,
  };
  const views = new Map<number, Float32Array>();
  for (const address of Object.values(addresses)) views.set(address, new Float32Array(memory, address, maxFrames));
  processor.dsp = {
    maxBlockFrames: maxFrames,
    memory: { buffer: memory },
    ...addresses,
    leftA: views.get(addresses.leftAAddress), rightA: views.get(addresses.rightAAddress),
    leftB: views.get(addresses.leftBAddress), rightB: views.get(addresses.rightBAddress),
    dryLeft: views.get(addresses.dryLeftAddress), dryRight: views.get(addresses.dryRightAddress),
    oldLeftA: views.get(addresses.oldLeftAAddress), oldRightA: views.get(addresses.oldRightAAddress),
    oldLeftB: views.get(addresses.oldLeftBAddress), oldRightB: views.get(addresses.oldRightBAddress),
    activeHandles: [], retired: null, transitionFrames: 0, transitionElapsed: 0,
    wasm: {
      webrc_dsp_managed_memory_bytes() { return 0; },
      webrc_dsp_fx_destroy() { return 0; },
      webrc_dsp_fx_process_stereo(handle: number, sourceL: number, sourceR: number, destL: number, destR: number, frames: number) {
        const gain = handle === 1 ? 0.25 : 0.75;
        const inputLeft = views.get(sourceL)!;
        const inputRight = views.get(sourceR)!;
        const outputLeft = views.get(destL)!;
        const outputRight = views.get(destR)!;
        for (let frame = 0; frame < frames; frame += 1) {
          outputLeft[frame] = inputLeft[frame]! * gain;
          outputRight[frame] = inputRight[frame]! * gain;
        }
        return 0;
      },
    },
  };
  return { processor, scope, messages };
}

async function makeRealMasterProcessor(maxBlockFrames = 64, carrierAttached = false) {
  const messages: Array<Record<string, unknown>> = [];
  let Registered: (new (options: unknown) => TestProcessor) | null = null;
  const scope: Record<string, any> = {
    AudioWorkletProcessor: class {
      port = { onmessage: null, postMessage(message: Record<string, unknown>) { messages.push(message); } };
    },
    registerProcessor(_name: string, processor: new (options: unknown) => TestProcessor) { Registered = processor; },
    SharedArrayBuffer,
    Int32Array,
    Float32Array,
    Atomics,
    Math,
    Number,
    WebAssembly,
    sampleRate: 48_000,
    currentFrame: 0,
  };
  const source = readFileSync(resolve(process.cwd(), 'public/worklets/master-fx-processor.js'), 'utf8');
  runInNewContext(source, scope);
  if (!Registered) throw new Error('The master FX Worklet did not register.');
  const modulePath = process.env.WEBRC_DSP_WASM_PATH || resolve(process.cwd(), 'public/dsp/webrc-dsp.wasm');
  const module = await WebAssembly.compile(readFileSync(modulePath));
  const fxTransitionBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
  const fxCarrierControl = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  Atomics.store(new Int32Array(fxCarrierControl), 0, carrierAttached ? 1 : 0);
  const processor = new Registered({ processorOptions: { sharedDspModule: module, maxBlockFrames,
    fxTransitionBuffer, fxMidiBuffer: createBrowserFxMidiBuffer(), fxCarrierControl } });
  return { processor, scope, messages, fxTransitionControl: new Int32Array(fxTransitionBuffer), fxCarrierControl };
}

function vinylPlan(count: number) {
  return Array.from({ length: count }, () => ({ ordinal: 53, parameters: [
    { id: 48, value: 1 }, { id: 21, value: 1 }, { id: 55, value: 0.35 },
  ] }));
}

function expectedVinylStartupWarmupFrames(count: number, maxBlockFrames: number) {
  return count * (4 * 48_000 + maxBlockFrames + 12);
}

function makeStereoTone(startFrame: number, frames: number) {
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    const absolute = startFrame + frame;
    left[frame] = 0.24 + 0.045 * Math.sin(2 * Math.PI * 220 * absolute / 48_000);
    right[frame] = -0.16 + 0.031 * Math.sin(2 * Math.PI * 997 * absolute / 48_000);
  }
  return { left, right };
}

function makeStereoCarrierTone(startFrame: number, frames: number) {
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    const absolute = startFrame + frame;
    left[frame] = 0.42 * Math.sin(2 * Math.PI * 733 * absolute / 48_000);
    right[frame] = 0.31 * Math.sin(2 * Math.PI * 997 * absolute / 48_000 + 0.37);
  }
  return { left, right };
}

function processRealMasterBlock(
  processor: TestProcessor, scope: Record<string, any>, startFrame: number, frames = 64,
  carrier?: { left: Float32Array; right: Float32Array },
) {
  scope.currentFrame = startFrame;
  const input = makeStereoTone(startFrame, frames);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  processor.process([[input.left, input.right], carrier ? [carrier.left, carrier.right] : []], [[left, right]]);
  return { left, right };
}

function lastMessage(messages: Array<Record<string, unknown>>, type: string) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.type === type) return messages[index]!;
  }
  throw new Error(`Missing Worklet reply ${type}.`);
}

describe('master shared-DSP Worklet', () => {
  it('primes VOCODER with paired real modulator/carrier history and processes independent stereo', async () => {
    const withoutCarrier = await makeRealMasterProcessor(128, false);
    withoutCarrier.processor.handleMessage({ type: 'MASTER_DSP_FX_BANK_STAGE', requestId: 801,
      plan: [{ ordinal: 20, parameters: [{ id: 48, value: 1 }, { id: 3, value: 1 }] }] });
    expect(lastMessage(withoutCarrier.messages, 'MASTER_DSP_FX_BANK_STAGED')).toMatchObject({ ok: false });
    expect(withoutCarrier.processor.dsp.activeHandles).toHaveLength(0);

    const tested = await makeRealMasterProcessor(128, true);
    for (let block = 0; block < 12; block += 1) {
      const startFrame = block * 128;
      processRealMasterBlock(tested.processor, tested.scope, startFrame, 128,
        makeStereoCarrierTone(startFrame, 128));
    }
    expect(tested.processor.dsp.fxHistoryCount).toBe(1_536);
    expect(tested.processor.dsp.fxCarrierHistoryCount).toBe(1_536);
    expect(tested.processor.dsp.fxCarrierHistoryLeft.some((sample: number) => Math.abs(sample) > 0.01)).toBe(true);
    expect(tested.processor.dsp.fxCarrierHistoryRight.some((sample: number) => Math.abs(sample) > 0.01)).toBe(true);

    tested.processor.handleMessage({ type: 'MASTER_DSP_FX_BANK_STAGE', requestId: 802,
      plan: [{ ordinal: 20, parameters: [{ id: 48, value: 1 }, { id: 3, value: 1 }] }] });
    const staged = lastMessage(tested.messages, 'MASTER_DSP_FX_BANK_STAGED');
    expect(staged).toMatchObject({ ok: true, handleCount: 1 });
    const stageId = Number(staged.stageId);
    tested.processor.handleMessage({ type: 'MASTER_DSP_FX_BANK_COMMIT', requestId: 803, stageId, allowHistoryWarmup: true });
    expect(lastMessage(tested.messages, 'MASTER_DSP_FX_BANK_COMMITTED')).toMatchObject({ ok: true });
    expect(tested.processor.dsp.activeOrdinals).toEqual([20]);

    const startFrame = 1_536;
    const carrier = makeStereoCarrierTone(startFrame, 128);
    const rendered = processRealMasterBlock(tested.processor, tested.scope, startFrame, 128, carrier);
    expect(tested.processor.processFailures).toBe(0);
    expect(rendered.left.some((sample) => Math.abs(sample) > 1e-5)).toBe(true);
    expect(rendered.right.some((sample) => Math.abs(sample) > 1e-5)).toBe(true);
    expect(rendered.left.some((sample, index) => Math.abs(sample - rendered.right[index]!) > 1e-6)).toBe(true);
  }, 120_000);

  it('broadcasts one MIDI span only to compatible Harmony mode and Voc(M), without chain failure', async () => {
    const tested = await makeRealMasterProcessor(64, false);
    const control = await makeRealMasterProcessor(64, false);
    const plan = [
      { ordinal: 19, parameters: [{ id: 48, value: 1 }, { id: 107, value: 2 }] },
      { ordinal: 21, parameters: [{ id: 48, value: 1 }, { id: 3, value: 1 }] },
    ];
    for (const item of [tested, control]) {
      item.processor.handleMessage({ type: 'MASTER_DSP_FX_BANK_STAGE', requestId: 811, plan });
      const staged = lastMessage(item.messages, 'MASTER_DSP_FX_BANK_STAGED');
      expect(staged.ok).toBe(true);
      item.processor.handleMessage({ type: 'MASTER_DSP_FX_BANK_COMMIT', requestId: 812, stageId: staged.stageId });
      expect(lastMessage(item.messages, 'MASTER_DSP_FX_BANK_COMMITTED').ok).toBe(true);
    }
    // Harmony's non-MIDI mode still has a bounded analysis warmup. Deliver
    // genuine render callbacks until that serial candidate and its transition
    // have finished before testing an audible Voc(M) note.
    const warmBlocks = Math.ceil((4_777 + Math.round(48_000 * 0.01)) / 64);
    for (let block = 0; block < warmBlocks; block += 1) {
      const startFrame = block * 64;
      processRealMasterBlock(tested.processor, tested.scope, startFrame, 64);
      processRealMasterBlock(control.processor, control.scope, startFrame, 64);
    }
    expect(tested.processor.dsp.activeMidiCapable).toEqual([false, true]);

    const writer = new BrowserFxMidiQueueWriter(tested.processor.dsp.fxMidiBuffer);
    const eventStartFrame = warmBlocks * 64;
    expect(writer.enqueue({ type: 'NoteOn', channel: 0, note: 69, velocity: 112, timestampMs: 0 }, eventStartFrame + 17)).toBe(true);
    expect(writer.enqueue({ type: 'NoteOff', channel: 0, note: 69, velocity: 0, timestampMs: 1 }, eventStartFrame + 48)).toBe(true);
    const testedOutput = processRealMasterBlock(tested.processor, tested.scope, eventStartFrame, 64);
    const controlOutput = processRealMasterBlock(control.processor, control.scope, eventStartFrame, 64);
    expect(tested.processor.processFailures).toBe(0);
    for (let frame = 0; frame < 17; frame += 1) {
      expect(testedOutput.left[frame]).toBe(controlOutput.left[frame]);
      expect(testedOutput.right[frame]).toBe(controlOutput.right[frame]);
    }
    expect(testedOutput.left.slice(17).some((sample, index) =>
      Math.abs(sample - controlOutput.left[index + 17]!) > 1e-6)).toBe(true);
    expect(testedOutput.right.slice(17).some((sample, index) =>
      Math.abs(sample - controlOutput.right[index + 17]!) > 1e-6)).toBe(true);
  }, 120_000);

  it('preallocates replacement lifecycle fields before callback promotion', () => {
    const { processor, messages } = makeMasterProcessor();
    const dsp = processor.dsp;
    dsp.memory = { buffer: { byteLength: 64 * 1024 * 1024 } };
    dsp.wasm.memory = dsp.memory;
    dsp.initialIdsAddress = 0;
    dsp.initialValuesAddress = 0;
    dsp.initialIds = new Uint32Array(64);
    dsp.initialValues = new Float32Array(64);
    dsp.startupWarmupOut = new Uint32Array(1);
    dsp.fxHistoryFrames = 128;
    dsp.fxHistoryLeft = new Float32Array(128);
    dsp.fxHistoryRight = new Float32Array(128);
    dsp.fxHistoryWrite = 0;
    dsp.fxHistoryCount = 0;
    dsp.staged = null;
    dsp.warming = null;
    dsp.wasm.webrc_dsp_fx_is_processor_available = () => 1;
    dsp.wasm.webrc_dsp_fx_create_v2 = () => 2;
    dsp.wasm.webrc_dsp_fx_last_create_status = () => 0;
    dsp.wasm.webrc_dsp_fx_latency_model = () => 0;
    dsp.wasm.webrc_dsp_fx_fixed_latency_samples = () => 0;
    dsp.wasm.webrc_dsp_fx_startup_warmup_upper_bound_samples_for_parameters = (...args: unknown[]) => {
      dsp.startupWarmupOut[0] = 1;
      return 0;
    };
    dsp.wasm.webrc_dsp_fx_startup_warmup_frames = () => 1;

    processor.handleMessage({ type: 'MASTER_DSP_FX_BANK_STAGE', requestId: 700,
      plan: [{ ordinal: 1, parameters: [] }] });
    const staged = dsp.staged as Record<string, unknown>;
    expect(lastMessage(messages, 'MASTER_DSP_FX_BANK_STAGED').ok).toBe(true);
    const stagedKeys = Reflect.ownKeys(staged).sort();
    expect(stagedKeys).toEqual(expect.arrayContaining([
      'stageId', 'handles', 'warmupFrames', 'warmedFrames', 'failed',
      'wetGain', 'wetTarget', 'wetStep', 'wetRampRemaining',
    ]));

    processor.handleMessage({ type: 'MASTER_DSP_FX_BANK_COMMIT', requestId: 701,
      stageId: staged.stageId, allowHistoryWarmup: false });
    expect(dsp.warming).toBe(staged);
    const inputLeft = Float32Array.of(0.25);
    const inputRight = Float32Array.of(-0.125);
    const outputLeft = new Float32Array(1);
    const outputRight = new Float32Array(1);
    expect(processor.process([[inputLeft, inputRight]], [[outputLeft, outputRight]])).toBe(true);
    expect(dsp.retired).toBe(staged);
    expect(Reflect.ownKeys(staged).sort()).toEqual(stagedKeys);
    expect(staged.warmedFrames).toBe(1);
  });

  it('treats repeated finalization of the same retired stage as idempotent', () => {
    const { processor, messages } = makeMasterProcessor();
    let destroyCalls = 0;
    processor.dsp.wasm.webrc_dsp_fx_destroy = () => { destroyCalls += 1; return 0; };
    processor.dsp.retired = { stageId: 77, handles: [5] };
    processor.dsp.transitionFrames = 10;
    processor.dsp.transitionElapsed = 10;

    processor.handleMessage({ type: 'MASTER_DSP_FX_BANK_FINALIZE', requestId: 1, stageId: 77 });
    expect(lastMessage(messages, 'MASTER_DSP_FX_BANK_FINALIZED')).toMatchObject({ ok: true });
    expect(destroyCalls).toBe(1);
    processor.handleMessage({ type: 'MASTER_DSP_FX_BANK_FINALIZE', requestId: 2, stageId: 77 });
    expect(lastMessage(messages, 'MASTER_DSP_FX_BANK_FINALIZED')).toMatchObject({ ok: true, idempotent: true });
    expect(destroyCalls).toBe(1);
  });

  it('keeps the dry path finite when either input channel contains NaN or infinity', () => {
    const { processor } = makeMasterProcessor();
    processor.wetGain = 0.35;
    processor.wetTarget = 0.35;
    const inputLeft = Float32Array.of(Number.NaN, Number.POSITIVE_INFINITY, 0.5, -0.25);
    const inputRight = Float32Array.of(0.25, Number.NEGATIVE_INFINITY, 0.125, -0.5);
    const outputLeft = new Float32Array(4);
    const outputRight = new Float32Array(4);
    processor.process([[inputLeft, inputRight]], [[outputLeft, outputRight]]);

    expect(Array.from(outputLeft).every(Number.isFinite)).toBe(true);
    expect(Array.from(outputRight).every(Number.isFinite)).toBe(true);
    expect(Array.from(outputLeft.slice(0, 2))).toEqual([0, 0]);
    expect(Array.from(outputRight.slice(0, 2))).toEqual([0.25, 0]);
    expect(outputLeft[2]).toBeCloseTo(0.5, 6);
    expect(outputRight[2]).toBeCloseTo(0.125, 6);
    expect(processor.nonFiniteSamples).toBe(3);
  });

  it('crossfades the old stereo chain to a replacement over prepared frames', () => {
    const { processor, scope } = makeMasterProcessor();
    const dsp = processor.dsp;
    dsp.activeHandles = [2];
    dsp.retired = { handles: [1] };
    dsp.transitionFrames = 480;
    dsp.transitionElapsed = 0;
    processor.fxTransitionControl = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2));
    processor.fxTransitionControl[1] = 480;
    const inputLeft = new Float32Array(64).fill(0.5);
    const inputRight = new Float32Array(64).fill(-0.25);
    const outputLeft = new Float32Array(64);
    const outputRight = new Float32Array(64);
    let previousLeft = 0.125;
    let previousRight = -0.0625;
    let maximumStep = 0;

    for (let block = 0; block < 8; block += 1) {
      scope.currentFrame = block * 64;
      processor.process([[inputLeft, inputRight]], [[outputLeft, outputRight]]);
      for (let frame = 0; frame < 64; frame += 1) {
        maximumStep = Math.max(maximumStep, Math.abs(outputLeft[frame]! - previousLeft),
          Math.abs(outputRight[frame]! - previousRight));
        previousLeft = outputLeft[frame]!;
        previousRight = outputRight[frame]!;
      }
    }
    expect(dsp.transitionElapsed).toBe(480);
    expect(Atomics.load(processor.fxTransitionControl, 1)).toBe(0);
    expect(outputLeft[63]).toBeCloseTo(0.375, 6);
    expect(outputRight[63]).toBeCloseTo(-0.1875, 6);
    expect(maximumStep).toBeLessThan(0.001);
  });

  it('crossfades an old attenuating stereo chain to the dry path on clear', () => {
    const { processor, scope } = makeMasterProcessor();
    const dsp = processor.dsp;
    dsp.activeHandles = [];
    dsp.retired = { handles: [1] };
    dsp.transitionFrames = 480;
    dsp.transitionElapsed = 0;
    const inputLeft = new Float32Array(64).fill(0.5);
    const inputRight = new Float32Array(64).fill(-0.25);
    const outputLeft = new Float32Array(64);
    const outputRight = new Float32Array(64);
    let previousLeft = 0.125;
    let previousRight = -0.0625;
    let maximumStep = 0;

    for (let block = 0; block < 8; block += 1) {
      scope.currentFrame = block * 64;
      processor.process([[inputLeft, inputRight]], [[outputLeft, outputRight]]);
      for (let frame = 0; frame < 64; frame += 1) {
        maximumStep = Math.max(maximumStep, Math.abs(outputLeft[frame]! - previousLeft),
          Math.abs(outputRight[frame]! - previousRight));
        previousLeft = outputLeft[frame]!;
        previousRight = outputRight[frame]!;
      }
    }
    expect(outputLeft[63]).toBeCloseTo(0.5, 6);
    expect(outputRight[63]).toBeCloseTo(-0.25, 6);
    expect(maximumStep).toBeLessThan(0.001);
  });

  it('separates real fixed alignment from serial startup-history warmup', async () => {
    const { processor, messages } = await makeRealMasterProcessor(64);
    const stageAndAbort = (count: number, expectedWarmupFrames: number) => {
      const bytesBefore = processor.dsp.wasm.webrc_dsp_managed_memory_bytes();
      processor.handleMessage({ type: 'MASTER_DSP_FX_BANK_STAGE', requestId: 10, plan: vinylPlan(count) });
      const reply = lastMessage(messages, 'MASTER_DSP_FX_BANK_STAGED');
      expect(reply).toMatchObject({ ok: true, handleCount: count, warmupFrames: expectedWarmupFrames });
      const handles = processor.dsp.staged.handles as number[];
      expect(handles).toHaveLength(count);
      expect(handles.map((handle) => processor.dsp.wasm.webrc_dsp_fx_startup_warmup_frames(handle)))
        .toEqual(Array(count).fill(192_076));
      expect(handles.map((handle) => processor.dsp.wasm.webrc_dsp_fx_fixed_latency_samples(handle)))
        .toEqual(Array(count).fill(960));
      expect(handles.reduce((sum, handle) =>
        sum + processor.dsp.wasm.webrc_dsp_fx_startup_warmup_frames(handle), 0)).toBe(expectedWarmupFrames);
      expect(handles.reduce((sum, handle) =>
        sum + processor.dsp.wasm.webrc_dsp_fx_fixed_latency_samples(handle), 0)).toBe(count * 960);
      processor.handleMessage({ type: 'MASTER_DSP_FX_BANK_ABORT', requestId: 11, stageId: reply.stageId });
      expect(lastMessage(messages, 'MASTER_DSP_FX_BANK_ABORTED').ok).toBe(true);
      expect(processor.dsp.wasm.webrc_dsp_managed_memory_bytes()).toBe(bytesBefore);
    };

    expect(expectedVinylStartupWarmupFrames(1, 64)).toBe(192_076);
    expect(expectedVinylStartupWarmupFrames(2, 64)).toBe(384_152);
    expect(expectedVinylStartupWarmupFrames(4, 64)).toBe(768_304);
    stageAndAbort(1, 192_076);
    stageAndAbort(2, 384_152);
    stageAndAbort(4, 768_304);
  }, 120_000);

  it('warms a running serial candidate from live 55 Hz stereo frames and begins the fade next block', async () => {
    const { processor, scope, messages, fxTransitionControl } = await makeRealMasterProcessor(512);
    let frame = 0;
    const stageId = (() => {
      processor.handleMessage({ type: 'MASTER_DSP_FX_BANK_STAGE', requestId: 201, plan: vinylPlan(4) });
      const reply = lastMessage(messages, 'MASTER_DSP_FX_BANK_STAGED');
      expect(expectedVinylStartupWarmupFrames(4, 512)).toBe(770_096);
      expect(reply).toMatchObject({ ok: true, warmupFrames: 770_096 });
      const handles = processor.dsp.staged.handles as number[];
      expect(handles.map((handle) => processor.dsp.wasm.webrc_dsp_fx_startup_warmup_frames(handle)))
        .toEqual(Array(4).fill(192_524));
      expect(handles.map((handle) => processor.dsp.wasm.webrc_dsp_fx_fixed_latency_samples(handle)))
        .toEqual(Array(4).fill(960));
      expect(handles.reduce((sum, handle) =>
        sum + processor.dsp.wasm.webrc_dsp_fx_startup_warmup_frames(handle), 0)).toBe(770_096);
      expect(handles.reduce((sum, handle) =>
        sum + processor.dsp.wasm.webrc_dsp_fx_fixed_latency_samples(handle), 0)).toBe(3_840);
      return Number(reply.stageId);
    })();
    processor.handleMessage({ type: 'MASTER_DSP_FX_BANK_COMMIT', requestId: 202, stageId });
    expect(lastMessage(messages, 'MASTER_DSP_FX_BANK_COMMITTED')).toMatchObject({ ok: true, warming: true });
    expect(processor.dsp.activeHandles).toHaveLength(0);
    expect(processor.dsp.warming.warmedFrames).toBe(0);
    const startupFrames = expectedVinylStartupWarmupFrames(4, 512);
    expect(startupFrames).toBe(770_096);
    expect(Atomics.load(fxTransitionControl, 1)).toBe(startupFrames + 480);

    let priorLeft: number | null = null;
    let priorRight: number | null = null;
    let maximumStep = 0;
    const render = (frames: number, expectDry = true) => {
      const inputLeft = new Float32Array(frames);
      const inputRight = new Float32Array(frames);
      const outputLeft = new Float32Array(frames);
      const outputRight = new Float32Array(frames);
      for (let index = 0; index < frames; index += 1) {
        inputLeft[index] = 0.21 + 0.04 * Math.sin(2 * Math.PI * 55 * (frame + index) / 48_000);
        inputRight[index] = -0.17 + 0.03 * Math.sin(2 * Math.PI * 73 * (frame + index) / 48_000);
      }
      scope.currentFrame = frame;
      processor.process([[inputLeft, inputRight]], [[outputLeft, outputRight]]);
      for (let index = 0; index < frames; index += 1) {
        if (priorLeft !== null) maximumStep = Math.max(maximumStep, Math.abs(outputLeft[index]! - priorLeft));
        if (priorRight !== null) maximumStep = Math.max(maximumStep, Math.abs(outputRight[index]! - priorRight));
        if (expectDry) {
          expect(outputLeft[index]).toBeCloseTo(inputLeft[index]!, 6);
          expect(outputRight[index]).toBeCloseTo(inputRight[index]!, 6);
        } else {
          expect(Number.isFinite(outputLeft[index]!)).toBe(true);
          expect(Number.isFinite(outputRight[index]!)).toBe(true);
        }
        priorLeft = outputLeft[index]!;
        priorRight = outputRight[index]!;
      }
      frame += frames;
    };

    for (let block = 0; block < 7; block += 1) render(512);
    expect(processor.dsp.warming.warmedFrames).toBe(3_584);
    expect(Atomics.load(fxTransitionControl, 1)).toBe(startupFrames - 3_584 + 480);
    while (processor.dsp.warming.warmedFrames + 512 < startupFrames) {
      const before = processor.dsp.warming.warmedFrames;
      render(512);
      expect(processor.dsp.warming.warmedFrames).toBe(before + 512);
      expect(Atomics.load(fxTransitionControl, 1)).toBe(
        startupFrames - processor.dsp.warming.warmedFrames + 480);
    }
    const remainingWarmupFrames = startupFrames - processor.dsp.warming.warmedFrames;
    expect(remainingWarmupFrames).toBeGreaterThan(0);
    expect(remainingWarmupFrames).toBeLessThanOrEqual(512);
    if (remainingWarmupFrames > 1) render(remainingWarmupFrames - 1);
    expect(processor.dsp.warming.warmedFrames).toBe(startupFrames - 1);
    expect(Atomics.load(fxTransitionControl, 1)).toBe(481);
    render(1); // Complete startup on the exact boundary; the fade begins next callback.
    expect(processor.dsp.warming).toBeNull();
    expect(processor.dsp.retired.stageId).toBe(stageId);
    expect(processor.dsp.transitionElapsed).toBe(0);
    expect(Atomics.load(fxTransitionControl, 1)).toBe(480);
    render(512, false); // The 10 ms old→new fade starts on the next callback.
    expect(processor.dsp.transitionElapsed).toBe(480);
    expect(Atomics.load(fxTransitionControl, 1)).toBe(0);
    expect(maximumStep).toBeLessThan(0.01);
    processor.handleMessage({ type: 'MASTER_DSP_FX_BANK_FINALIZE', requestId: 203, stageId });
    expect(lastMessage(messages, 'MASTER_DSP_FX_BANK_FINALIZED').ok).toBe(true);
    processor.handleMessage({ type: 'MASTER_DSP_FX_BANK_FINALIZE', requestId: 204, stageId });
    expect(lastMessage(messages, 'MASTER_DSP_FX_BANK_FINALIZED')).toMatchObject({ ok: true, idempotent: true });
  }, 120_000);

  it('keeps the old 1→2→4-stage wet chain live through serial warmup and rolls back a failed candidate', async () => {
    const tested = await makeRealMasterProcessor(512);
    const control = await makeRealMasterProcessor(512);
    let frame = 0;
    let maximumStep = 0;
    let previousLeft: number | null = null;
    let previousRight: number | null = null;
    const renderPair = (frames: number, requireIdentical: boolean) => {
      const left = processRealMasterBlock(tested.processor, tested.scope, frame, frames);
      const reference = processRealMasterBlock(control.processor, control.scope, frame, frames);
      for (let index = 0; index < frames; index += 1) {
        expect(Number.isFinite(left.left[index]!)).toBe(true);
        expect(Number.isFinite(left.right[index]!)).toBe(true);
        if (requireIdentical) {
          expect(left.left[index]).toBe(reference.left[index]);
          expect(left.right[index]).toBe(reference.right[index]);
        }
        if (previousLeft !== null) maximumStep = Math.max(maximumStep,
          Math.abs(left.left[index]! - previousLeft), Math.abs(left.right[index]! - previousRight!));
        previousLeft = left.left[index]!;
        previousRight = left.right[index]!;
      }
      frame += frames;
      return left;
    };
    const stageAndCommit = (processor: TestProcessor, messages: Array<Record<string, unknown>>, plan: ReturnType<typeof vinylPlan>) => {
      processor.handleMessage({ type: 'MASTER_DSP_FX_BANK_STAGE', requestId: 401, plan });
      const staged = lastMessage(messages, 'MASTER_DSP_FX_BANK_STAGED');
      expect(staged.ok).toBe(true);
      processor.handleMessage({ type: 'MASTER_DSP_FX_BANK_COMMIT', requestId: 402, stageId: staged.stageId });
      expect(lastMessage(messages, 'MASTER_DSP_FX_BANK_COMMITTED').ok).toBe(true);
      return { stageId: Number(staged.stageId), warmupFrames: Number(staged.warmupFrames) };
    };
    const installWhileRunning = (count: number, expectedWarmupFrames: number) => {
      const bytesBeforeStage = tested.processor.dsp.wasm.webrc_dsp_managed_memory_bytes();
      const a = stageAndCommit(tested.processor, tested.messages, vinylPlan(count));
      const b = stageAndCommit(control.processor, control.messages, vinylPlan(count));
      expect(a.warmupFrames).toBe(expectedWarmupFrames);
      expect(b.warmupFrames).toBe(expectedWarmupFrames);
      const stagedHandles = tested.processor.dsp.staged ? tested.processor.dsp.staged.handles : tested.processor.dsp.warming.handles;
      expect(stagedHandles.reduce((sum: number, handle: number) =>
        sum + tested.processor.dsp.wasm.webrc_dsp_fx_startup_warmup_frames(handle), 0)).toBe(expectedWarmupFrames);
      expect(stagedHandles.reduce((sum: number, handle: number) =>
        sum + tested.processor.dsp.wasm.webrc_dsp_fx_fixed_latency_samples(handle), 0)).toBe(count * 960);
      const candidateBytes = tested.processor.dsp.wasm.webrc_dsp_managed_memory_bytes();
      expect(candidateBytes).toBeGreaterThan(bytesBeforeStage);
      const priorHandleCount = tested.processor.dsp.activeHandles.length;
      expect(control.processor.dsp.activeHandles).toHaveLength(priorHandleCount);
      expect(Atomics.load(tested.fxTransitionControl, 1)).toBe(expectedWarmupFrames + 480);
      while (tested.processor.dsp.warming !== null) {
        const warming = tested.processor.dsp.warming;
        expect(Atomics.load(tested.fxTransitionControl, 1)).toBe(
          warming.warmupFrames - warming.warmedFrames + 480);
        renderPair(512, true);
        const candidateActivated = Atomics.load(tested.fxTransitionControl, 1) === 480;
        expect(tested.processor.dsp.activeHandles).toHaveLength(candidateActivated ? count : priorHandleCount);
        if (tested.processor.dsp.warming !== null) {
          expect(Atomics.load(tested.fxTransitionControl, 1)).toBe(
            tested.processor.dsp.warming.warmupFrames - tested.processor.dsp.warming.warmedFrames + 480);
        }
      }
      expect(tested.processor.dsp.warming).toBeNull();
      expect(tested.processor.dsp.retired.stageId).toBe(a.stageId);
      expect(tested.processor.dsp.activeHandles).toHaveLength(count);
      expect(Atomics.load(tested.fxTransitionControl, 1)).toBe(480);
      renderPair(512, true);
      expect(Atomics.load(tested.fxTransitionControl, 1)).toBe(0);
      for (const current of [tested, control]) {
        current.processor.handleMessage({ type: 'MASTER_DSP_FX_BANK_FINALIZE', requestId: 403, stageId: current === tested ? a.stageId : b.stageId });
        expect(lastMessage(current.messages, 'MASTER_DSP_FX_BANK_FINALIZED').ok).toBe(true);
      }
      const bytesAfterFinalize = tested.processor.dsp.wasm.webrc_dsp_managed_memory_bytes();
      if (priorHandleCount > 0) expect(bytesAfterFinalize).toBeLessThan(candidateBytes);
      else expect(bytesAfterFinalize).toBeLessThanOrEqual(candidateBytes);
    };

    expect(expectedVinylStartupWarmupFrames(1, 512)).toBe(192_524);
    expect(expectedVinylStartupWarmupFrames(2, 512)).toBe(385_048);
    expect(expectedVinylStartupWarmupFrames(4, 512)).toBe(770_096);
    installWhileRunning(1, 192_524); // Startup history is separate from the 960-frame fixed alignment.
    installWhileRunning(2, 385_048);
    installWhileRunning(4, 770_096);
    expect(maximumStep).toBeLessThan(0.02);

    const oldHandles = tested.processor.dsp.activeHandles.slice();
    const oldBytes = tested.processor.dsp.wasm.webrc_dsp_managed_memory_bytes();
    tested.processor.handleMessage({ type: 'MASTER_DSP_FX_BANK_STAGE', requestId: 404, plan: vinylPlan(2) });
    const failedStage = lastMessage(tested.messages, 'MASTER_DSP_FX_BANK_STAGED');
    expect(failedStage).toMatchObject({ ok: true,
      warmupFrames: expectedVinylStartupWarmupFrames(2, tested.processor.dsp.maxBlockFrames) });
    const failedStageId = Number(failedStage.stageId);
    tested.processor.handleMessage({ type: 'MASTER_DSP_FX_BANK_COMMIT', requestId: 405, stageId: failedStageId });
    expect(lastMessage(tested.messages, 'MASTER_DSP_FX_BANK_COMMITTED')).toMatchObject({ ok: true, warming: true });
    const failedHandle = tested.processor.dsp.warming.handles[0];
    // Invalidate only the staged handle so the real WASM process export returns
    // its stale-handle error while the prior active chain continues rendering.
    tested.processor.dsp.wasm.webrc_dsp_fx_destroy(failedHandle);
    renderPair(64, true);
    expect(tested.processor.dsp.activeHandles).toEqual(oldHandles);
    expect(tested.processor.dsp.warming.failed).toBe(true);
    expect(Atomics.load(tested.fxTransitionControl, 1)).toBe(-1);
    tested.processor.handleMessage({ type: 'MASTER_DSP_FX_BANK_ROLLBACK', requestId: 406, stageId: failedStageId });
    expect(lastMessage(tested.messages, 'MASTER_DSP_FX_BANK_ROLLED_BACK').ok).toBe(true);
    expect(tested.processor.dsp.activeHandles).toEqual(oldHandles);
    expect(tested.processor.dsp.warming).toBeNull();
    expect(tested.processor.dsp.retired).toBeNull();
    expect(tested.processor.dsp.wasm.webrc_dsp_managed_memory_bytes()).toBe(oldBytes);
  }, 120_000);

  it('rejects stopped warmup when captured real input history is shorter than serial startup history', async () => {
    const { processor, messages } = await makeRealMasterProcessor(128);
    const managedBytesBefore = processor.dsp.wasm.webrc_dsp_managed_memory_bytes();
    processor.handleMessage({ type: 'MASTER_DSP_FX_BANK_STAGE', requestId: 301, plan: vinylPlan(1) });
    const staged = lastMessage(messages, 'MASTER_DSP_FX_BANK_STAGED');
    expect(expectedVinylStartupWarmupFrames(1, 128)).toBe(192_140);
    expect(staged).toMatchObject({ ok: true, warmupFrames: 192_140 });
    const stageId = Number(staged.stageId);
    processor.handleMessage({ type: 'MASTER_DSP_FX_BANK_COMMIT', requestId: 302, stageId, allowHistoryWarmup: true });
    expect(lastMessage(messages, 'MASTER_DSP_FX_BANK_COMMITTED')).toMatchObject({ ok: false });
    expect(processor.dsp.activeHandles).toHaveLength(0);
    expect(processor.dsp.staged.stageId).toBe(stageId);
    expect(processor.dsp.warming).toBeNull();
    expect(processor.dsp.retired).toBeNull();
    processor.handleMessage({ type: 'MASTER_DSP_FX_BANK_ABORT', requestId: 303, stageId });
    expect(lastMessage(messages, 'MASTER_DSP_FX_BANK_ABORTED')).toMatchObject({ ok: true });
    expect(processor.dsp.wasm.webrc_dsp_managed_memory_bytes()).toBe(managedBytesBefore);
  });

  it('uses the configured pitch profile startup bound before accepting a master bank', async () => {
    const { processor, messages } = await makeRealMasterProcessor(64);
    processor.handleMessage({ type: 'MASTER_DSP_FX_BANK_STAGE', requestId: 900, plan: [
      { ordinal: 18, parameters: [{ id: 48, value: 1 }, { id: 3, value: 1 }] },
    ] });
    const livePoly = lastMessage(messages, 'MASTER_DSP_FX_BANK_STAGED');
    expect(livePoly).toMatchObject({ ok: true, warmupFrames: 9_216, handleCount: 1 });
    if (livePoly.ok && typeof livePoly.stageId === 'number') {
      processor.handleMessage({ type: 'MASTER_DSP_FX_BANK_ABORT', requestId: 901, stageId: livePoly.stageId });
    }

    processor.handleMessage({ type: 'MASTER_DSP_FX_BANK_STAGE', requestId: 902, plan: [
      { ordinal: 18, parameters: [
        { id: 48, value: 1 }, { id: 3, value: 1 }, { id: 125, value: 2 },
      ] },
    ] });
    expect(lastMessage(messages, 'MASTER_DSP_FX_BANK_STAGED')).toMatchObject({ ok: false });
    expect(processor.dsp.wasm.webrc_dsp_managed_memory_bytes()).toBeLessThanOrEqual(48 * 1024 * 1024);
    processor.handleMessage({ type: 'MASTER_DSP_DISPOSE' });
  });
});
