import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

type TestProcessor = {
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
  handleMessage(message: Record<string, unknown>): void;
  processFailures: number;
  nonFiniteSamples: number;
  wetGain: number;
  wetTarget: number;
  wetStep: number;
  wetRampRemaining: number;
  primeFxHandles(handles: number[], warmupFrames: number): boolean;
  fxTransitionControl: Int32Array | null;
  fxTransitionIndex: number;
  dsp: Record<string, any>;
};

function makeMasterProcessor() {
  let Registered: (new () => object) | null = null;
  const scope: Record<string, any> = {
    AudioWorkletProcessor: class { port = { postMessage() {} }; },
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
    processCallbacks: 0, processedFrames: 0, outputFrames: 0, processFailures: 0, nonFiniteSamples: 0,
    lastFrameEnd: -1, lastFrameStart: -1, lastQuantumFrames: 0, minimumQuantumFrames: 0, maximumQuantumFrames: 0,
    frameDiscontinuities: 0, wetGain: 1, wetTarget: 1, wetStep: 0, wetRampRemaining: 0,
    fxTransitionControl: null, fxTransitionIndex: 1,
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
  return { processor, scope };
}

async function makeRealMasterProcessor(maxBlockFrames = 64) {
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
  const module = await WebAssembly.compile(readFileSync(resolve(process.cwd(), 'public/dsp/webrc-dsp.wasm')));
  const fxTransitionBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
  const processor = new Registered({ processorOptions: { sharedDspModule: module, maxBlockFrames,
    fxTransitionBuffer } });
  return { processor, scope, messages, fxTransitionControl: new Int32Array(fxTransitionBuffer) };
}

function vinylPlan(count: number) {
  return Array.from({ length: count }, () => ({ ordinal: 53, parameters: [
    { id: 48, value: 1 }, { id: 21, value: 1 }, { id: 55, value: 0.35 },
  ] }));
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

function processRealMasterBlock(
  processor: TestProcessor, scope: Record<string, any>, startFrame: number, frames = 64,
) {
  scope.currentFrame = startFrame;
  const input = makeStereoTone(startFrame, frames);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  processor.process([[input.left, input.right]], [[left, right]]);
  return { left, right };
}

function lastMessage(messages: Array<Record<string, unknown>>, type: string) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.type === type) return messages[index]!;
  }
  throw new Error(`Missing Worklet reply ${type}.`);
}

describe('master shared-DSP Worklet', () => {
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

  it('warms real fixed-latency WASM FX by the sum of serial slots before acknowledging the swap', async () => {
    const { processor, scope, messages, fxTransitionControl } = await makeRealMasterProcessor();
    let frame = 0;
    let previousLeft: number | null = null;
    let previousRight: number | null = null;
    let largestTransitionStep = 0;
    let independentStereoObserved = false;
    for (let block = 0; block < 75; block += 1) {
      const output = processRealMasterBlock(processor, scope, frame);
      frame += 64;
      previousLeft = output.left[63]!;
      previousRight = output.right[63]!;
    }

    const stage = (plan: ReturnType<typeof vinylPlan>) => {
      processor.handleMessage({ type: 'MASTER_DSP_FX_BANK_STAGE', requestId: 10, plan });
      const reply = lastMessage(messages, 'MASTER_DSP_FX_BANK_STAGED');
      expect(reply.ok).toBe(true);
      return Number(reply.stageId);
    };
    const commit = (stageId: number, expectedOk = true) => {
      processor.handleMessage({ type: 'MASTER_DSP_FX_BANK_COMMIT', requestId: 11, stageId, allowHistoryWarmup: true });
      expect(lastMessage(messages, 'MASTER_DSP_FX_BANK_COMMITTED').ok).toBe(expectedOk);
    };
    const renderFade = () => {
      for (let block = 0; block < 8; block += 1) {
        const output = processRealMasterBlock(processor, scope, frame);
        frame += 64;
        for (let index = 0; index < output.left.length; index += 1) {
          if (previousLeft !== null) largestTransitionStep = Math.max(largestTransitionStep,
            Math.abs(output.left[index]! - previousLeft));
          if (previousRight !== null) largestTransitionStep = Math.max(largestTransitionStep,
            Math.abs(output.right[index]! - previousRight));
          if (Math.abs(output.left[index]! - output.right[index]!) > 0.05) independentStereoObserved = true;
          previousLeft = output.left[index]!;
          previousRight = output.right[index]!;
          expect(Number.isFinite(output.left[index]!)).toBe(true);
          expect(Number.isFinite(output.right[index]!)).toBe(true);
        }
      }
      expect(Atomics.load(fxTransitionControl, 1)).toBe(0);
    };
    const finalize = (stageId: number) => {
      processor.handleMessage({ type: 'MASTER_DSP_FX_BANK_FINALIZE', requestId: 12, stageId });
      expect(lastMessage(messages, 'MASTER_DSP_FX_BANK_FINALIZED').ok).toBe(true);
    };

    const failedManagedBytes = processor.dsp.wasm.webrc_dsp_managed_memory_bytes();
    processor.handleMessage({ type: 'MASTER_DSP_FX_BANK_STAGE', requestId: 13, plan: [
      { ordinal: 53, parameters: [{ id: 999, value: 1 }] },
    ] });
    expect(lastMessage(messages, 'MASTER_DSP_FX_BANK_STAGED').ok).toBe(false);
    expect(processor.dsp.activeHandles).toHaveLength(0);
    expect(processor.dsp.wasm.webrc_dsp_managed_memory_bytes()).toBe(failedManagedBytes);

    const firstStageId = stage(vinylPlan(1));
    expect(lastMessage(messages, 'MASTER_DSP_FX_BANK_STAGED').warmupFrames).toBe(960);
    commit(firstStageId);
    processor.handleMessage({ type: 'MASTER_DSP_FX_BANK_FINALIZE', requestId: 14, stageId: firstStageId });
    expect(lastMessage(messages, 'MASTER_DSP_FX_BANK_FINALIZED').ok).toBe(false);
    renderFade();
    finalize(firstStageId);

    const twoStageId = stage(vinylPlan(2));
    expect(lastMessage(messages, 'MASTER_DSP_FX_BANK_STAGED').warmupFrames).toBe(1_920);
    expect(processor.dsp.wasm.webrc_dsp_fx_fixed_latency_samples(processor.dsp.activeHandles[0])).toBe(960);
    commit(twoStageId);
    renderFade();
    finalize(twoStageId);

    const fourStageId = stage(vinylPlan(4));
    expect(lastMessage(messages, 'MASTER_DSP_FX_BANK_STAGED').warmupFrames).toBe(3_840);
    commit(fourStageId);
    renderFade();
    finalize(fourStageId);
    expect(independentStereoObserved).toBe(true);
    expect(largestTransitionStep).toBeLessThan(0.02);

    const stableHandles = processor.dsp.activeHandles.slice();
    const stableBytes = processor.dsp.wasm.webrc_dsp_managed_memory_bytes();
    const primeFxHandles = processor.primeFxHandles;
    processor.primeFxHandles = () => false;
    const rejectedCommitStage = stage(vinylPlan(1));
    commit(rejectedCommitStage, false);
    expect(lastMessage(messages, 'MASTER_DSP_FX_BANK_COMMITTED').ok).toBe(false);
    expect(processor.dsp.activeHandles).toEqual(stableHandles);
    expect(processor.dsp.retired).toBeNull();
    processor.primeFxHandles = primeFxHandles;
    processor.handleMessage({ type: 'MASTER_DSP_FX_BANK_ABORT', requestId: 15, stageId: rejectedCommitStage });
    expect(lastMessage(messages, 'MASTER_DSP_FX_BANK_ABORTED').ok).toBe(true);
    expect(processor.dsp.wasm.webrc_dsp_managed_memory_bytes()).toBe(stableBytes);

    const clearStageId = stage([]);
    expect(lastMessage(messages, 'MASTER_DSP_FX_BANK_STAGED').warmupFrames).toBe(0);
    commit(clearStageId);
    renderFade();
    finalize(clearStageId);
    const nonFiniteLeft = Float32Array.of(Number.NaN, Number.POSITIVE_INFINITY, 0.24, 0.25);
    const nonFiniteRight = Float32Array.of(Number.NEGATIVE_INFINITY, Number.NaN, -0.16, -0.17);
    const outputLeft = new Float32Array(4);
    const outputRight = new Float32Array(4);
    processor.process([[nonFiniteLeft, nonFiniteRight]], [[outputLeft, outputRight]]);
    expect(Array.from(outputLeft).every(Number.isFinite)).toBe(true);
    expect(Array.from(outputRight).every(Number.isFinite)).toBe(true);
    expect(outputLeft[0]).toBe(0);
    expect(outputRight[0]).toBe(0);
  });

  it('warms a running serial candidate from live 55 Hz stereo frames and begins the fade next block', async () => {
    const { processor, scope, messages, fxTransitionControl } = await makeRealMasterProcessor(512);
    let frame = 0;
    const stageId = (() => {
      processor.handleMessage({ type: 'MASTER_DSP_FX_BANK_STAGE', requestId: 201, plan: vinylPlan(4) });
      const reply = lastMessage(messages, 'MASTER_DSP_FX_BANK_STAGED');
      expect(reply).toMatchObject({ ok: true, warmupFrames: 3_840 });
      return Number(reply.stageId);
    })();
    processor.handleMessage({ type: 'MASTER_DSP_FX_BANK_COMMIT', requestId: 202, stageId });
    expect(lastMessage(messages, 'MASTER_DSP_FX_BANK_COMMITTED')).toMatchObject({ ok: true, warming: true });
    expect(processor.dsp.activeHandles).toHaveLength(0);
    expect(processor.dsp.warming.warmedFrames).toBe(0);
    expect(Atomics.load(fxTransitionControl, 1)).toBe(4_320);

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

    render(512);
    render(512);
    render(512);
    render(512);
    render(512);
    render(512);
    render(512);
    expect(processor.dsp.warming.warmedFrames).toBe(3_584);
    expect(Atomics.load(fxTransitionControl, 1)).toBe(736);
    render(300); // Crosses the 3,840-frame warm boundary 256 samples into this callback.
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
  });

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
        sum + tested.processor.dsp.wasm.webrc_dsp_fx_fixed_latency_samples(handle), 0)).toBe(expectedWarmupFrames);
      const candidateBytes = tested.processor.dsp.wasm.webrc_dsp_managed_memory_bytes();
      expect(candidateBytes).toBeGreaterThan(bytesBeforeStage);
      const priorHandleCount = tested.processor.dsp.activeHandles.length;
      expect(control.processor.dsp.activeHandles).toHaveLength(priorHandleCount);
      while (Atomics.load(tested.fxTransitionControl, 1) > 480) {
        renderPair(512, true);
        const candidateActivated = Atomics.load(tested.fxTransitionControl, 1) === 480;
        expect(tested.processor.dsp.activeHandles).toHaveLength(candidateActivated ? count : priorHandleCount);
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

    installWhileRunning(1, 960); // Dry→one real fixed-latency processor.
    installWhileRunning(2, 1_920); // One wet processor remains audible while two replacements warm.
    installWhileRunning(4, 3_840); // Serial latency is the sum of all four getters.
    expect(maximumStep).toBeLessThan(0.02);

    const oldHandles = tested.processor.dsp.activeHandles.slice();
    const oldBytes = tested.processor.dsp.wasm.webrc_dsp_managed_memory_bytes();
    tested.processor.handleMessage({ type: 'MASTER_DSP_FX_BANK_STAGE', requestId: 404, plan: vinylPlan(2) });
    const failedStage = lastMessage(tested.messages, 'MASTER_DSP_FX_BANK_STAGED');
    expect(failedStage).toMatchObject({ ok: true, warmupFrames: 1_920 });
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
  });

  it('rejects stopped warmup when the captured real input history is shorter than the serial latency', async () => {
    const { processor, messages } = await makeRealMasterProcessor(128);
    const managedBytesBefore = processor.dsp.wasm.webrc_dsp_managed_memory_bytes();
    processor.handleMessage({ type: 'MASTER_DSP_FX_BANK_STAGE', requestId: 301, plan: vinylPlan(1) });
    const staged = lastMessage(messages, 'MASTER_DSP_FX_BANK_STAGED');
    expect(staged).toMatchObject({ ok: true, warmupFrames: 960 });
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
});
