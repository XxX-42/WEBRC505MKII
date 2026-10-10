import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { BrowserAudioEngine } from '../../src/audio/BrowserAudioEngine';
import { createBrowserFxMidiBuffer } from '../../src/audio/browserFxMidiProtocol';
import type { ProjectFxBank, ProjectFxUnit } from '../../src/project/projectTypes';
import type { SharedDspFxBankPlan, SharedDspFxCatalogEntry } from '../../src/audio/sharedDspGraph';

const wasmPath = process.env.WEBRC_DSP_WASM_PATH;
const describeWithWasm = wasmPath ? describe : describe.skip;

const transposeDescriptor: SharedDspFxCatalogEntry = {
  ordinal: 14,
  id: 'rc505mkii.fx.transpose',
  displayName: 'TRANSPOSE',
  family: 'pitch',
  officialParametersValidated: false,
  parameters: [
    { id: 48, name: 'Active', unit: 'boolean', minimum: 0, maximum: 1, defaultValue: 0, origin: 0 },
    { id: 3, name: 'Mix', unit: 'linear', minimum: 0, maximum: 1, defaultValue: 1, origin: 0 },
    { id: 93, name: 'Semitones', unit: 'semitones', minimum: -12, maximum: 12, defaultValue: 0, origin: 0 },
    { id: 125, name: 'PitchProfile', unit: 'choice', minimum: 0, maximum: 2, defaultValue: 1, origin: 0 },
  ],
};

interface BrowserFxFacadeInternals {
  sharedDspFxCatalog: SharedDspFxCatalogEntry[];
  fxBanks: ProjectFxBank[];
  activeFxBankId: string;
  setFxType(location: 'input' | 'track', slotIndex: number, type: string): void;
  setFxParam(location: 'input' | 'track', slotIndex: number, value: number): void;
  setFxActive(location: 'input' | 'track', slotIndex: number, active: boolean): void;
  sharedDspPlanForBank(bank: ProjectFxBank): SharedDspFxBankPlan;
  updateFxBankSlot: ReturnType<typeof vi.fn>;
}

describeWithWasm('Browser shared FX facade activation reaches real WASM PCM', () => {
  it('selects TRANSPOSE through the facade, keeps it internally active, and changes real stereo PCM', async () => {
    const moduleBytes = readFileSync(wasmPath!);
    const module = await WebAssembly.compile(moduleBytes);
    const facade = Object.assign(Object.create(BrowserAudioEngine.prototype), {
      sharedDspFxCatalog: [structuredClone(transposeDescriptor)],
      updateFxBankSlot: vi.fn(async () => undefined),
    }) as unknown as BrowserFxFacadeInternals;

    facade.setFxType('track', 0, 'SHARED_DSP_FX_14');
    const selected = facade.updateFxBankSlot.mock.calls[0]?.[2] as ProjectFxUnit | undefined;
    expect(selected).toBeDefined();
    expect(selected?.enabled).toBe(true);
    expect(selected?.params['48']).toBe(1);
    expect(selected?.params['125']).toBe(1);
    if (!selected) throw new Error('The Browser FX facade did not create the selected unit.');

    const bank: ProjectFxBank = {
      id: 'facade-activation', name: 'Facade activation',
      input: [null, null, null, null],
      track: [structuredClone(selected), null, null, null],
      output: [null, null, null, null],
    };
    facade.fxBanks = [bank];
    facade.activeFxBankId = bank.id;
    facade.setFxParam('track', 0, 100 * (7 + 12) / 24);
    const configured = facade.updateFxBankSlot.mock.calls.at(-1)?.[2] as ProjectFxUnit | undefined;
    expect(configured?.params['93']).toBeCloseTo(7, 6);
    expect(configured?.params['48']).toBe(1);
    if (!configured) throw new Error('The Browser continuous control did not update the selected unit.');
    bank.track[0] = configured;

    facade.setFxActive('track', 0, false);
    expect(facade.updateFxBankSlot.mock.calls.at(-1)?.[2].params['48']).toBe(0);
    facade.setFxActive('track', 0, true);
    expect(facade.updateFxBankSlot.mock.calls.at(-1)?.[2].params['48']).toBe(1);

    const facadePlan = facade.sharedDspPlanForBank(bank).track;
    expect(facadePlan).toHaveLength(1);
    expect(facadePlan[0]?.parameters).toContainEqual({ id: 48, value: 1 });
    expect(facadePlan[0]?.parameters).toContainEqual({ id: 93, value: 7 });

    const disabledComparator = structuredClone(bank);
    disabledComparator.track[0]!.params['48'] = 0;
    const bypassPlan = facade.sharedDspPlanForBank(disabledComparator).track;
    const activeOutput = await renderMasterPlan(module, facadePlan);
    const bypassOutput = await renderMasterPlan(module, bypassPlan);

    const comparedStart = 12_000;
    const activeDelta = activeOutput.left.slice(comparedStart).map((sample, index) => sample - bypassOutput.left[comparedStart + index]!);
    const rightDelta = activeOutput.right.slice(comparedStart).map((sample, index) => sample - bypassOutput.right[comparedStart + index]!);
    expect(rms(activeDelta)).toBeGreaterThan(1e-3);
    expect(rms(rightDelta)).toBeGreaterThan(1e-3);
    expect(activeOutput.right.slice(comparedStart)).not.toEqual(activeOutput.left.slice(comparedStart));
  }, 60_000);
});

async function renderMasterPlan(module: WebAssembly.Module, plan: SharedDspFxBankPlan['track']) {
  let Processor: (new (options: unknown) => any) | null = null;
  const messages: Array<Record<string, unknown>> = [];
  const scope: Record<string, any> = {
    AudioWorkletProcessor: class {
      port = { onmessage: null, postMessage(message: Record<string, unknown>) { messages.push(message); } };
    },
    registerProcessor(_name: string, processor: new (options: unknown) => any) { Processor = processor; },
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
  const workletSource = readFileSync(resolve(process.cwd(), 'public/worklets/master-fx-processor.js'), 'utf8');
  runInNewContext(workletSource, scope);
  if (!Processor) throw new Error('Master FX Worklet did not register.');
  const transitionBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
  const carrierControl = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const processor = new Processor({ processorOptions: {
    sharedDspModule: module,
    maxBlockFrames: 64,
    fxTransitionBuffer: transitionBuffer,
    fxMidiBuffer: createBrowserFxMidiBuffer(),
    fxCarrierControl: carrierControl,
  } });

  processor.handleMessage({ type: 'MASTER_DSP_FX_BANK_STAGE', requestId: 1, plan });
  const staged = [...messages].reverse().find((message) => message.type === 'MASTER_DSP_FX_BANK_STAGED');
  if (!staged?.ok || typeof staged.stageId !== 'number') {
    throw new Error(`Real Master Worklet rejected the facade plan: ${String(staged?.message ?? 'no staged response')}`);
  }
  processor.handleMessage({ type: 'MASTER_DSP_FX_BANK_COMMIT', requestId: 2, stageId: staged.stageId });
  const committed = [...messages].reverse().find((message) => message.type === 'MASTER_DSP_FX_BANK_COMMITTED');
  if (!committed?.ok) throw new Error(`Real Master Worklet failed to commit: ${String(committed?.message ?? 'no commit response')}`);

  const frameCount = 18_000;
  const left = new Float32Array(frameCount);
  const right = new Float32Array(frameCount);
  for (let start = 0; start < frameCount; start += 64) {
    const frames = Math.min(64, frameCount - start);
    scope.currentFrame = start;
    const inLeft = new Float32Array(frames);
    const inRight = new Float32Array(frames);
    const outLeft = new Float32Array(frames);
    const outRight = new Float32Array(frames);
    for (let frame = 0; frame < frames; frame += 1) {
      const absolute = start + frame;
      inLeft[frame] = 0.23 * Math.sin(2 * Math.PI * 220 * absolute / 48_000) + 0.04;
      inRight[frame] = 0.19 * Math.sin(2 * Math.PI * 733 * absolute / 48_000 + 0.31) - 0.025;
    }
    processor.process([[inLeft, inRight]], [[outLeft, outRight]]);
    left.set(outLeft, start);
    right.set(outRight, start);
  }
  if (processor.processFailures !== 0) throw new Error(`Master Worklet had ${processor.processFailures} process failures.`);
  processor.handleMessage({ type: 'MASTER_DSP_DISPOSE' });
  return { left, right };
}

function rms(values: Float32Array): number {
  let sum = 0;
  for (const value of values) sum += value * value;
  return Math.sqrt(sum / Math.max(1, values.length));
}
