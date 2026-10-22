import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserAudioEngine } from '../../src/audio/BrowserAudioEngine';
import { BrowserWorkletFX } from '../../src/audio/fx/BrowserWorkletFX';
import { BrowserTrackFxChain } from '../../src/audio/BrowserTrackFxChain';
import { Transport } from '../../src/core/Transport';

class Node { connect = vi.fn(); disconnect = vi.fn(); gain = { value: 1, setValueAtTime: vi.fn(), setTargetAtTime: vi.fn(), cancelScheduledValues: vi.fn(), linearRampToValueAtTime: vi.fn() }; }
class Worklet extends Node { static instances: Worklet[] = []; port = { postMessage: vi.fn() }; constructor(public context: AudioContext, public name: string, public options: AudioWorkletNodeOptions) { super(); Worklet.instances.push(this); } }
function engineHarness() {
  const engine = Object.create(BrowserAudioEngine.prototype) as BrowserAudioEngine;
  const context = { sampleRate: 48000, currentTime: 0, audioWorklet: { addModule: vi.fn(async () => {}) }, createGain: () => new Node() } as unknown as AudioContext;
  Object.assign(engine, { context, inputFxChain: { input: new Node(), output: new Node() }, outputFxChain: { input: new Node(), output: new Node() }, trackMixNode: new Node(), currentInputStream: null, inputFxInstances: [null,null,null,null], trackFxInstances: [null,null,null,null], inputFxTypes: [null,null,null,null], trackFxTypes: [null,null,null,null], inputFxActive: [false,false,false,false], trackFxActive: [false,false,false,false], fxWorkletModuleReady: null, fxWorkletGeneration: 0, lastError: '', statusListeners: new Set() });
  return engine;
}
const originalMeter = [...Transport.getInstance().timeSignature] as [number, number];
const originalBpm = Transport.getInstance().bpm;
afterEach(() => { Transport.getInstance().bpm = originalBpm; Transport.getInstance().timeSignature = originalMeter; Worklet.instances = []; vi.unstubAllGlobals(); });
describe('Official parameters reach every Browser bank consistently', () => {
  it('initializes and updates Input/shared Track tempo at the real transport BPM', async () => {
    vi.stubGlobal('AudioWorkletNode', Worklet);
    Transport.getInstance().bpm = 165;
    Transport.getInstance().timeSignature = [3, 4];
    const engine = engineHarness();
    engine.setFxType('input', 0, 'DSP LPF'); engine.setFxType('track', 0, 'PHASER');
    await vi.waitFor(() => expect(Worklet.instances).toHaveLength(2));
    for (const node of Worklet.instances) expect(node.options.processorOptions?.parameters).toMatchObject({ bpm: 165, quarterNotesPerMeasure: 3 });
    engine.setFxNamedParameters('input', 0, { official_rate: -1, official_depth: 50 });
    engine.setFxNamedParameters('track', 0, { official_rate: -1, official_depth: 50 });
    Transport.getInstance().bpm = 90;
    Transport.getInstance().timeSignature = [7, 8];
    (engine as unknown as { handleTransportBpmChange(): void }).handleTransportBpmChange();
    const state = engine as unknown as { inputFxInstances: BrowserWorkletFX[]; trackFxInstances: BrowserWorkletFX[] };
    expect(state.inputFxInstances[0]!.getParameterSnapshot()).toMatchObject({ bpm: 90, quarterNotesPerMeasure: 3.5, official_rate: -1 });
    expect(state.trackFxInstances[0]!.getParameterSnapshot()).toMatchObject({ bpm: 90, quarterNotesPerMeasure: 3.5, official_rate: -1 });
    engine.setFxParam('input', 0, 80);
    expect(state.inputFxInstances[0]!.getParameterSnapshot()).toMatchObject({ official_rate: -1, official_depth: 50 });
  });
  it('rejects unknown tempo values at the shared public boundary and routes variants first', async () => {
    vi.stubGlobal('AudioWorkletNode', Worklet);
    const engine = engineHarness();
    engine.setFxType('input', 0, 'TAPE ECHO');
    await vi.waitFor(() => expect(Worklet.instances).toHaveLength(1));
    engine.setFxNamedParameters('input', 0, { official_repeat_rate: 200, official_variant: 2 });
    const state = engine as unknown as { inputFxInstances: BrowserWorkletFX[]; lastError: string };
    expect(state.inputFxInstances[0]!.getParameterSnapshot()).toMatchObject({ official_variant: 2, official_repeat_rate: 200 });
    engine.setFxNamedParameters('input', 0, { official_repeat_rate: -3.14159 });
    expect(state.lastError).toContain('Unsupported official');
    expect(state.inputFxInstances[0]!.getParameterSnapshot()).toMatchObject({ official_repeat_rate: 200 });
  });
});

it('private Track bank preserves master meter at construction and later updates', async () => {
 vi.stubGlobal('AudioWorkletNode', Worklet);
 const engine = engineHarness();
 const context = (engine as unknown as { context: AudioContext }).context;
 let meter = 3;
 const bank = new BrowserTrackFxChain(context, async () => {}, () => {}, () => 120, () => meter);
 expect(bank.setType(0, 'DSP LPF')).toBe(true);
 await vi.waitFor(() => expect(Worklet.instances).toHaveLength(1));
 expect(Worklet.instances[0]!.options.processorOptions?.parameters).toMatchObject({ quarterNotesPerMeasure: 3 });
 expect(bank.setNamedParameters(0, { official_rate: -4 })).toBe(true);
 meter = 3.5; bank.setBpm(150);
 expect(bank.getRecoverySnapshot()[0]!.parameters).toMatchObject({ bpm: 150, quarterNotesPerMeasure: 3.5, official_rate: -4 });
});

it('Transport emits meter changes once and measures compound signatures in quarter notes', () => {
 const transport = Transport.getInstance();
 transport.timeSignature = [4, 4];
 const changed = vi.fn(); transport.on('time-signature-change', changed);
 try { transport.timeSignature = [6, 8]; transport.timeSignature = [6, 8]; expect(changed).toHaveBeenCalledTimes(1); expect(transport.quarterNotesPerMeasure).toBe(3); }
 finally { transport.off('time-signature-change', changed); }
});
