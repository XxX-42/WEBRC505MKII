import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pitchHarness = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('../../src/audio/pitch/signalsmith', () => ({ createLiveInputTransposeNode: pitchHarness.create }));

import { BrowserAudioEngine } from '../../src/audio/BrowserAudioEngine';
import { BrowserTrackFxChain } from '../../src/audio/BrowserTrackFxChain';
import { BROWSER_TRACK_FX_COVERAGE } from '../../src/audio/browserTrackFxCoverage';
import { planBrowserRecoveryFxGraph } from '../../src/audio/BrowserRecoveryFxGraph';
import { createBrowserRecoverySharedFxBank } from '../../src/audio/BrowserRecoverySharedFxBank';
import type { BrowserRecoveryFxSlot, BrowserRecoverySnapshot } from '../../src/audio/BrowserRecoverySnapshot';
import { BrowserWorkletFX } from '../../src/audio/fx/BrowserWorkletFX';
import type { FXBase } from '../../src/audio/fx/FXBase';
import { getBrowserInputFxControls, getBrowserTrackFxControls } from '../../src/composables/browserTrackFxParameters';
import { Transport } from '../../src/core/Transport';

// This suite exercises real factories, host dispatch, snapshots and recovery
// admission. Web Audio and Signalsmith are mocked; it does not claim DSP/timbre
// parity. Source-reader routes have their own actual-loop regression suite.
class Parameter {
  value = 1;
  setTargetAtTime(value: number) { this.value = value; }
  setValueAtTime(value: number) { this.value = value; }
  linearRampToValueAtTime(value: number) { this.value = value; }
  cancelScheduledValues() {}
  setValueCurveAtTime() {}
}
class Node {
  gain = new Parameter();
  delayTime = new Parameter();
  pan = new Parameter();
  connections: unknown[][] = [];
  connect(...args: unknown[]) { this.connections.push(args); }
  disconnect() {}
}
class Worklet extends Node {
  messages: Array<{ type?: string; parameters?: object }> = [];
  port = { postMessage: (message: { type?: string; parameters?: object }) => { this.messages.push(message); }, onmessage: null };
  constructor(_context: AudioContext, _name: string, readonly options: AudioWorkletNodeOptions) { super(); }
}
const context = () => ({
  state: 'suspended', sampleRate: 48000, currentTime: 0,
  audioWorklet: { addModule: async () => undefined },
  createGain: () => new Node(), createDelay: () => new Node(), createStereoPanner: () => new Node(),
}) as unknown as AudioContext;

type Route = 'input' | 'track' | 'private';
type Adapter = FXBase & { algorithm: string; ready: Promise<void>; processorReady: boolean; error: string };
type EngineInternals = { inputFxInstances: Adapter[]; trackFxInstances: Adapter[]; lastError: string };
type ChainInternals = { slots: Array<{ pending: { effect: Adapter } | null; effect: Adapter | null }> };
const meter = 3.5;
const bpm = 107;
const sourceReaderTypes = new Set(['BEAT SHIFT', 'VINYL FLICK']);
const routes: Route[] = ['input', 'track', 'private'];
const cases = BROWSER_TRACK_FX_COVERAGE.flatMap(entry => {
  if (sourceReaderTypes.has(entry.type)) return [];
  return routes.flatMap(route => (['TAPE ECHO', 'ROLL'].includes(entry.type) ? [1, 2] : [0]).flatMap(variant => {
    const parameters: Record<string, number> = variant ? { official_variant: variant } : {};
    const allControls = route === 'input'
      ? getBrowserInputFxControls(entry.type, parameters)
      : getBrowserTrackFxControls(entry.type, parameters, 0, route === 'private' ? 'private' : 'shared');
    const controls = allControls.filter(control => control.provenance !== 'extension');
    const extensions = allControls.filter(control => control.provenance === 'extension');
    return controls.length ? [{ type: entry.type, route, variant, controls, extensions }] : [];
  }));
});
type SweepCase = typeof cases[number];

const originalBpm = Transport.getInstance().bpm;
const originalMeter = [...Transport.getInstance().timeSignature] as [number, number];
beforeEach(() => {
  vi.stubGlobal('AudioWorkletNode', Worklet);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  pitchHarness.create.mockImplementation(async () => Object.assign(new Node(), {
    latencySeconds: 0.024, latencySamples: 1152, setPitch: async () => undefined,
  }));
  Transport.getInstance().bpm = bpm;
  Transport.getInstance().timeSignature = [7, 8];
});
afterEach(() => {
  Transport.getInstance().bpm = originalBpm;
  Transport.getInstance().timeSignature = originalMeter;
  pitchHarness.create.mockReset();
  vi.unstubAllGlobals();
});

function makeEngine(ctx: AudioContext, sources: Node[]): BrowserAudioEngine {
  const engine = Object.create(BrowserAudioEngine.prototype) as BrowserAudioEngine;
  Object.assign(engine, {
    context: ctx, tracks: sources.map((playbackSourceOutput, index) => ({
      playbackSourceOutput, track: { id: index + 1 }, configureLoopTransportFx: () => undefined,
    })),
    inputFxChain: { input: new Node(), output: new Node() },
    outputFxChain: { input: new Node(), output: new Node() }, trackMixNode: new Node(), currentInputStream: null,
    inputFxInstances: [null, null, null, null], trackFxInstances: [null, null, null, null],
    inputFxTypes: [null, null, null, null], trackFxTypes: [null, null, null, null],
    inputFxActive: [false, false, false, false], trackFxActive: [false, false, false, false],
    fxWorkletModuleReady: null, fxWorkletGeneration: 0, lastError: '', statusListeners: new Set(),
  });
  return engine;
}

function emptyBank(): BrowserRecoveryFxSlot[] {
  return (['A', 'B', 'C', 'D'] as const).map(slot => ({
    slot, type: null, requestedType: null, active: false, requestedActive: null,
    state: 'empty', amount: null, parameters: {}, parametersCaptured: true, error: null,
  }));
}
function makeSnapshot(route: Route, slot: BrowserRecoveryFxSlot): BrowserRecoverySnapshot {
  const input = emptyBank(), sharedTrack = emptyBank(), privateTracks = Array.from({ length: 5 }, emptyBank);
  (route === 'input' ? input : route === 'track' ? sharedTrack : privateTracks[0]!)[0] = slot;
  return {
    schemaVersion: 2, source: { contextState: 'closed', sampleRate: 48000 },
    transport: { bpm, timeSignature: [7, 8] },
    tracks: Array.from({ length: 5 }, (_, index) => ({ trackId: index + 1, pitch: { mode: 'off' } })),
    fx: { input, sharedTrack, privateTracks, sourceOverrides: [], outputDsp: { algorithm: null, parameters: {}, enabled: false } },
  } as unknown as BrowserRecoverySnapshot;
}

async function authoredSlot(test: SweepCase): Promise<BrowserRecoveryFxSlot> {
  const ctx = context(), sources = Array.from({ length: 5 }, () => new Node());
  const engine = makeEngine(ctx, sources), internal = engine as unknown as EngineInternals;
  const bank = test.route === 'private' ? new BrowserTrackFxChain(ctx, async () => undefined, undefined,
    () => bpm, () => meter, id => sources[id - 1] as unknown as AudioNode) : null;
  let effect: Adapter | null = null;
  try {
    if (bank) {
      expect(bank.setType(0, test.type)).toBe(true);
      effect = (bank as unknown as ChainInternals).slots[0]!.pending!.effect;
    } else {
      engine.setFxType(test.route as 'input' | 'track', 0, test.type);
      effect = (test.route === 'input' ? internal.inputFxInstances : internal.trackFxInstances)[0]!;
    }
    expect(effect, `${test.type}/${test.route} must have an executable adapter`).toBeTruthy();
    // Exercise existing editors too, so their canonical snapshot keys (notably
    // private OSC VOC aliases) must remain restorable alongside official edits.
    for (const control of test.extensions) {
      const update = { [control.key]: control.defaultValue };
      if (bank) expect(bank.setNamedParameters(0, update), `${test.type}/${test.route}/${control.key}`).toBe(true);
      else engine.setFxNamedParameters(test.route as 'input' | 'track', 0, update);
      expect(effect!.error).toBe('');
    }
    const selected: Record<string, number> = {};
    for (const control of test.controls) selected[control.key] = control.key === 'official_variant' ? test.variant : control.defaultValue;
    // Every indexed STEP LEVEL address must survive, not just the selected UI step.
    if (test.type === 'STEP SLICER') for (let i = 1; i <= 16; i++) selected[`official_step_level_${i}`] = i * 5;
    for (const [key, value] of Object.entries(selected)) {
      if (bank) expect(bank.setNamedParameters(0, { [key]: value }), `${test.type}/${test.route}/${key}`).toBe(true);
      else engine.setFxNamedParameters(test.route as 'input' | 'track', 0, { [key]: value });
      expect(effect!.getParameterSnapshot?.(), `${test.type}/${test.route}/${key}`).toMatchObject({ [key]: value });
      expect(effect!.error).toBe('');
      expect(internal.lastError).toBe('');
    }
    await effect!.ready;
    await Promise.resolve();
    expect(effect!.processorReady).toBe(true);
    if (bank) expect(bank.getStatus(1).slots[0]!.state).toBe('ready');
    const parameters = effect!.getParameterSnapshot!();
    expect(parameters).toMatchObject(selected);
    if (effect instanceof BrowserWorkletFX || effect!.algorithm === 'auto-riff') {
      // Do not strip internal clock fields to make recovery pass.
      expect(parameters).toMatchObject({ bpm, quarterNotesPerMeasure: meter });
    }
    if (effect instanceof BrowserWorkletFX) {
      const worklet = (effect as unknown as { node: Worklet }).node;
      const posted = worklet.messages;
      for (const [key, value] of Object.entries(selected)) {
        expect(posted.some(message => message.type === 'configure' && (message.parameters as Record<string, number>)?.[key] === value),
          `${test.type}/${test.route}/${key} must reach the worklet configure boundary`).toBe(true);
      }
      if (test.type === 'VOCODER') expect(sources[0]!.connections.some(edge => edge[0] === worklet && edge[1] === 0 && edge[2] === 1)).toBe(true);
    }
    return { ...emptyBank()[0]!, type: test.type, state: 'ready', parameters: parameters as Record<string, number> };
  } finally {
    if (bank) bank.dispose();
    else effect?.dispose();
  }
}

describe('Browser shared/private official route and actual-snapshot sweep', () => {
  it('covers every non-source catalog route, both explicit variants and all sixteen step addresses', async () => {
    expect(new Set(cases.map(test => test.type)).size).toBe(51);
    expect(cases).toHaveLength(157);
    expect(routes.map(route => cases.filter(test => test.route === route).length)).toEqual([51, 53, 53]);
    expect(cases.reduce((sum, test) => sum + test.controls.filter(control => control.provenance === 'official-interface').length, 0)).toBe(756);
    expect(cases.reduce((sum, test) => sum + test.controls.filter(control => control.provenance === 'routing').length, 0)).toBe(15);
    expect(cases.reduce((sum, test) => sum + test.extensions.length, 0)).toBe(699);
    // 756 official controls + 45 additional STEP LEVEL addresses = 801 actual
    // official applications; 15 selectors are routing metadata, not FX knobs.
    // With 699 legacy editor applications, each authoring sweep makes 1,515
    // named edits. Recovery below repeats that authoring and restores 157 rows.
    expect(cases.reduce((sum, test) => sum + new Set([
      ...test.controls.map(control => control.key),
      ...(test.type === 'STEP SLICER' ? Array.from({ length: 16 }, (_, i) => `official_step_level_${i + 1}`) : []),
    ]).size, 0)).toBe(816);
    for (const test of cases) await authoredSlot(test);
  });

  it.each(cases)('restores $route $type variant=$variant without dropping host clock or canonical fields', async test => {
    const saved = await authoredSlot(test);
    const snapshot = makeSnapshot(test.route, saved);
    expect(() => planBrowserRecoveryFxGraph(snapshot, 0, { includeSharedBanks: true })).not.toThrow();
    const ctx = context(), sources = Array.from({ length: 5 }, () => new Node());
    const carrier = (id: number) => sources[id - 1] as unknown as AudioNode;
    if (test.route === 'private') {
      const bank = new BrowserTrackFxChain(ctx, async () => undefined, undefined, () => bpm, () => meter, carrier);
      try {
        expect(bank.setType(0, test.type)).toBe(true);
        expect(bank.setNamedParameters(0, saved.parameters as Record<string, number>)).toBe(true);
        const effect = (bank as unknown as ChainInternals).slots[0]!.pending!.effect;
        await effect.ready;
        await Promise.resolve();
        expect(bank.getStatus(1).slots[0]!.state).toBe('ready');
        expect(bank.getRecoverySnapshot()[0]!.parameters).toEqual(saved.parameters);
      } finally { bank.dispose(); }
    } else {
      const slots = emptyBank(); slots[0] = saved;
      const bank = createBrowserRecoverySharedFxBank(ctx, test.route === 'input' ? 'input' : 'sharedTrack', slots,
        async () => undefined, () => bpm, () => meter, carrier);
      try {
        for (let i = 0; i < 20; i++) await Promise.resolve();
        expect(bank.getStatuses()[0]!.state).toBe('ready');
        expect(bank.getRecoverySnapshot()[0]!.parameters).toEqual(saved.parameters);
      } finally { bank.dispose(); }
    }
  });
});
