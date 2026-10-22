import { afterEach, describe, expect, it, vi } from 'vitest';
const harness = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('../../src/audio/pitch/signalsmith', () => ({ createLiveInputTransposeNode: harness.create }));
import { BrowserTransposeFX } from '../../src/audio/fx/BrowserTransposeFX';
import { BrowserPitchBendFX } from '../../src/audio/fx/BrowserPitchBendFX';
import { BrowserRobotFX } from '../../src/audio/fx/BrowserRobotFX';
import { BrowserManualHarmonistFX } from '../../src/audio/fx/BrowserManualHarmonistFX';
import { BrowserHrmAutoFX } from '../../src/audio/fx/BrowserHrmAutoFX';
import { BrowserAutoRiffFX } from '../../src/audio/fx/BrowserAutoRiffFX';
import { BrowserOctaveFX } from '../../src/audio/fx/BrowserOctaveFX';
import { BrowserHrmAutoDsp } from '../../src/audio/fx/dsp/BrowserHrmAutoDsp';
import { BrowserRobotDsp } from '../../src/audio/fx/dsp/BrowserRobotDsp';
import { BROWSER_OFFICIAL_PITCH_PARAMETER_KEYS, BROWSER_OFFICIAL_PITCH_UNSUPPORTED, officialPitchDefaults } from '../../src/audio/fx/dsp/OfficialPitchParameters';
import { FxProcessor } from '../../src/audio/worklet/FxProcessor';

class Node { connect = vi.fn(); disconnect = vi.fn(); }
const param = (initial = 1) => ({ value: initial, setTargetAtTime: vi.fn(function(this: { value: number }, value: number) { this.value = value; }), cancelScheduledValues: vi.fn() });
class Gain extends Node { gain = param(); }
class Delay extends Node { delayTime = param(0); }
class Pan extends Node { pan = param(0); }
class Worklet extends Node {
  static instances: Worklet[] = [];
  port = { postMessage: vi.fn(), onmessage: null as ((event: { data: unknown }) => void) | null };
  onprocessorerror: (() => void) | null = null;
  constructor(readonly context: unknown, readonly name: string, readonly options: AudioWorkletNodeOptions) { super(); Worklet.instances.push(this); }
}
const context = () => ({ currentTime: 0, sampleRate: 48000, audioWorklet: { addModule: vi.fn(async () => undefined) }, createGain: () => new Gain(), createDelay: () => new Delay(), createStereoPanner: () => new Pan() }) as unknown as AudioContext;
const pitchNode = () => Object.assign(new Node(), { latencySeconds: 0.024, latencySamples: 1152, setPitch: vi.fn(async (..._args: unknown[]) => undefined) });
function prepare() { vi.stubGlobal('AudioWorkletNode', Worklet); const nodes: ReturnType<typeof pitchNode>[] = []; harness.create.mockImplementation(async () => { const node = pitchNode(); nodes.push(node); return node; }); return nodes; }
function feed(dsp: BrowserHrmAutoDsp | BrowserRobotDsp, midi: number, start = 0, count = dsp.sampleRate) {
  const hz = 440 * 2 ** ((midi - 69) / 12);
  for (let i = start; i < start + count; i += 1) dsp.processSample(0.3 * Math.sin(2 * Math.PI * hz * i / dsp.sampleRate), i);
}

describe('official dedicated pitch controls', () => {
  afterEach(() => { harness.create.mockReset(); Worklet.instances = []; vi.unstubAllGlobals(); });
  it('declares only 26 implemented official controls and explicitly reports all five unavailable controls', () => {
    expect(Object.values(BROWSER_OFFICIAL_PITCH_PARAMETER_KEYS).flat()).toHaveLength(26);
    expect(Object.values(BROWSER_OFFICIAL_PITCH_UNSUPPORTED).flatMap(Object.keys)).toHaveLength(5);
    expect(BROWSER_OFFICIAL_PITCH_PARAMETER_KEYS['auto-riff']).not.toContain('official_phrase');
  });
  it('TRANS reaches the pitch processor in semitones and rejects out-of-domain values', async () => {
    const nodes = prepare(); const fx = new BrowserTransposeFX(context()); await fx.ready;
    fx.setParam('official_trans', -12); expect(nodes[0]!.setPitch).toHaveBeenLastCalledWith(-12);
    fx.setParam('official_trans', 13); expect(fx.error).toMatch(/-12/); fx.dispose();
  });
  it('BEND is an absolute position across -3 to +4 octaves, not a timed sweep or semitone alias', async () => {
    const nodes = prepare(); const fx = new BrowserPitchBendFX(context()); await fx.ready;
    fx.setParam('official_pitch', 4); fx.setParam('official_bend', 100); fx.setBypass(false);
    expect(nodes[0]!.setPitch).toHaveBeenCalledTimes(1); expect(nodes[0]!.setPitch.mock.calls[0]![0]).toBe(48);
    fx.setParam('official_pitch', -3); expect(nodes[0]!.setPitch.mock.calls.at(-1)![0]).toBe(-36);
    fx.setParam('official_bend', 50); expect(nodes[0]!.setPitch.mock.calls.at(-1)![0]).toBe(-18);
    fx.setParam('official_bend', 0); expect(nodes[0]!.setPitch.mock.calls.at(-1)![0]).toBe(0);
    expect(harness.create).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ pitchRange: 'official-bend' }));
    fx.dispose();
  });
  it('never silently accepts unavailable MODE even if initialization completes later', async () => {
    prepare();
    const effects = [new BrowserTransposeFX(context()), new BrowserPitchBendFX(context()), new BrowserRobotFX(context(), async () => undefined), new BrowserOctaveFX(context())];
    for (const fx of effects) { fx.setParam('official_mode', 2); await fx.ready; fx.setBypass(false); expect(fx.error).toMatch(/unsupported/); expect(fx.processorReady).toBe(false); fx.dispose(); }
  });
  it('ROBOT NOTE is a fixed pitch and FORMANT enters the actual envelope-preserving schedule', async () => {
    const nodes = prepare(); const fx = new BrowserRobotFX(context(), async () => undefined); await fx.ready;
    fx.setParam('official_note', 9); fx.setParam('official_formant', 50); fx.setBypass(false);
    const worklet = Worklet.instances[0]!;
    expect(worklet.port.postMessage).toHaveBeenCalledWith({ type: 'configure', parameters: { robotNote: 9 } });
    worklet.port.onmessage?.({ data: { type: 'robot-pitch-target', frame: 1000, semitones: 12, sourceMidi: 57, targetMidi: 69, sourceHz: 220, confidence: 0.98, voiced: true } });
    expect(nodes[0]!.setPitch).toHaveBeenLastCalledWith(12, 1000 / 48000 + 0.024, false, 12, 220, true);
    fx.dispose();
    const dsp = new BrowserRobotDsp(48000, { note: 0 }); feed(dsp, 57); expect(dsp.targetMidi).toBe(60); expect(dsp.targetSemitones).toBeCloseTo(3, 0);
    feed(dsp, 69, 48000); expect(dsp.targetMidi).toBe(60); expect(dsp.targetSemitones).toBeCloseTo(-9, 0);
    dsp.setParameters({ note: 7 }); expect(dsp.targetMidi).toBe(67);
  });
  it('OCTAVE selection gates separate octave voices and OCT.LEVEL does not attenuate direct sound', async () => {
    prepare(); const fx = new BrowserOctaveFX(context()); await fx.ready; fx.setBypass(false);
    const state = fx as unknown as { voiceGains: Gain[]; dryGain: Gain };
    fx.setParam('official_oct_level', 80); fx.setParam('official_octave', 0);
    expect(state.voiceGains.map(v => v.gain.value)).toEqual([0, 0.8, 0]);
    fx.setParam('official_octave', 1); expect(state.voiceGains.map(v => v.gain.value)).toEqual([0.8, 0, 0]);
    fx.setParam('official_octave', 2); expect(state.voiceGains.map(v => v.gain.value)).toEqual([0.8, 0.8, 0]);
    fx.setParam('official_oct_level', 0); expect(state.voiceGains.map(v => v.gain.value)).toEqual([0, 0, 0]); expect(state.dryGain.gain.value).toBe(1); fx.dispose();
  });
  it('manual VOICE follows scale degrees and KEY changes the interval for the same source', () => {
    const c = new BrowserHrmAutoDsp(8000, { key: 0, officialManualVoice: 6 }); feed(c, 60);
    expect(c.targetVoiceCount).toBe(1); expect(c.targetSemitones1).toBeCloseTo(4, 0);
    const cm = new BrowserHrmAutoDsp(8000, { key: 3, officialManualVoice: 6 }); feed(cm, 60); expect(cm.targetSemitones1).toBeCloseTo(3, 0);
    c.setParameters({ officialManualVoice: 5 }); expect(c.targetSemitones1).toBeCloseTo(-3, 0);
    c.setParameters({ officialManualVoice: 0 }); expect(c.targetSemitones1).toBe(-12);
    c.setParameters({ officialManualVoice: 1 }); expect(c.targetSemitones1).toBe(12);
    c.setParameters({ officialManualVoice: 10 }); expect(c.targetSemitones1).toBeCloseTo(0.08, 6);
  });
  it('HRM AUTO VOICE and HYBRID/AUTO respond to actual held MIDI pitch classes and KEY', () => {
    const dsp = new BrowserHrmAutoDsp(8000, { key: 0, officialAutoVoice: 4, officialHrmMode: 1 });
    for (const note of [61, 65, 68]) dsp.enqueueMidiEvent('noteOn', 1, note, 100, 0);
    feed(dsp, 60); expect(dsp.targetSemitones1).toBeCloseTo(1, 0);
    dsp.setParameters({ officialHrmMode: 0 }); expect(dsp.targetSemitones1).toBeCloseTo(5, 0);
    dsp.setParameters({ key: 1 }); expect(dsp.targetSemitones1).toBeCloseTo(1, 0);
    dsp.setParameters({ officialAutoVoice: 5 }); expect(dsp.targetSemitones1).toBeCloseTo(5, 0);
    dsp.setParameters({ officialAutoVoice: 3 }); expect(dsp.targetSemitones1).toBeCloseTo(-4, 0);
    dsp.setParameters({ officialAutoVoice: 2 }); expect(dsp.targetSemitones1).toBeCloseTo(-7, 0);
  });
  it('manual adapter connects its analyzer and applies FORMANT/PAN/direct/harmony levels independently', async () => {
    const nodes = prepare(); const fx = new BrowserManualHarmonistFX(context());
    for (const [key, value] of Object.entries({ voice: 6, formant: -50, pan: -50, key: 3, d_level: 35, hrm_level: 65 })) fx.setParam(`official_${key}`, value);
    await fx.ready; fx.setBypass(false); const worklet = Worklet.instances[0]!;
    expect(worklet.options.processorOptions.parameters).toMatchObject({ hrmAutoOfficialManualVoice: 6, hrmAutoKey: 3 });
    worklet.port.onmessage?.({ data: { type: 'hrm-auto-target', frame: 1000, voiceCount: 1, target1: 3 } });
    expect(nodes[0]!.setPitch).toHaveBeenLastCalledWith(3, 1000 / 48000 + 0.024, true, -12, 0, true);
    const state = fx as unknown as { voicePan: Pan; voiceMutes: Gain[]; voiceGain: Gain; dryGain: Gain };
    expect(state.voicePan.pan.value).toBe(-1); expect(state.dryGain.gain.value).toBe(0.35); expect(state.voiceGain.gain.value).toBe(0.65);
    expect(state.voiceMutes.map(v => v.gain.value)).toEqual([1, 0]); fx.dispose();
  });
  it('auto adapter applies all seven controls through DSP targets, stereo pan and independent gains', async () => {
    const nodes = prepare(); const fx = new BrowserHrmAutoFX(context(), async () => undefined); await fx.ready;
    for (const [key, value] of Object.entries({ voice: 5, formant: 25, pan: 50, hrm_mode: 0, key: 4, d_level: 20, hrm_level: 90 })) fx.setParam(`official_${key}`, value);
    fx.setBypass(false); const worklet = Worklet.instances[0]!;
    expect(worklet.port.postMessage).toHaveBeenCalledWith({ type: 'configure', parameters: { hrmAutoOfficialVoice: 5, hrmAutoOfficialHrmMode: 0, hrmAutoKey: 4, hrmAutoScale: 0 } });
    worklet.port.onmessage?.({ data: { type: 'hrm-auto-target', frame: 1000, voiceCount: 1, target1: 7, target2: -128 } });
    expect(nodes[0]!.setPitch).toHaveBeenLastCalledWith(7, 1000 / 48000 + 0.024, false, 6, 0, true);
    const state = fx as unknown as { voicePan: Pan; voiceGains: Gain[]; dryGain: Gain };
    expect(state.voicePan.pan.value).toBe(1); expect(state.dryGain.gain.value).toBe(0.2); expect(state.voiceGains.map(v => v.gain.value)).toEqual([0.9, 0]);
    fx.setParam('official_hrm_level', 0); expect(state.voiceGains[0]!.gain.value).toBe(0); expect(state.dryGain.gain.value).toBe(0.2); fx.dispose();
  });
  it('worklet plumbing produces manual harmony without MIDI rather than just recording configuration', () => {
    const host = globalThis as unknown as { currentFrame?: number }; const previous = host.currentFrame;
    const processor = new FxProcessor({ processorOptions: { algorithm: 'hrm-auto', sampleRate: 8000, parameters: { hrmAutoOfficialManualVoice: 6, hrmAutoKey: 0 }, bypassed: false } });
    const post = vi.fn(); processor.port.postMessage = post;
    try {
      for (let frame = 0; frame < 4000; frame += 100) {
        host.currentFrame = frame; const input = Float32Array.from({ length: 100 }, (_, i) => 0.25 * Math.sin(2 * Math.PI * 261.625565 * (frame + i) / 8000));
        processor.process([[input]], [[new Float32Array(100), new Float32Array(100)]]);
      }
    } finally { if (previous === undefined) delete host.currentFrame; else host.currentFrame = previous; }
    const targets = post.mock.calls.map(([m]) => m).filter(m => m.type === 'hrm-auto-target' && m.voiceCount === 1);
    expect(targets.length).toBeGreaterThan(0); expect(targets.at(-1).target1).toBeCloseTo(4, 0);
  });
});

// A recovery snapshot carries authored scalar controls, not transient detector or
// MIDI history. Re-feed identical detector events after restoring a fresh node.
type SnapshotEffect = BrowserTransposeFX | BrowserPitchBendFX | BrowserRobotFX | BrowserManualHarmonistFX | BrowserHrmAutoFX | BrowserOctaveFX | BrowserAutoRiffFX;
const createSnapshotEffect = (algorithm: string): SnapshotEffect => {
  const ctx = context();
  switch (algorithm) {
    case 'transpose': return new BrowserTransposeFX(ctx);
    case 'pitch-bend': return new BrowserPitchBendFX(ctx);
    case 'robot': return new BrowserRobotFX(ctx, async () => undefined);
    case 'hrm-manual': return new BrowserManualHarmonistFX(ctx);
    case 'hrm-auto': return new BrowserHrmAutoFX(ctx, async () => undefined);
    case 'octave': return new BrowserOctaveFX(ctx);
    default: return new BrowserAutoRiffFX(ctx, async () => undefined);
  }
};
function audibleState(fx: SnapshotEffect) {
  const state = fx as unknown as {
    directGain: Gain; dryGain: Gain; wetGain?: Gain; voiceGains?: Gain[]; voiceMutes?: Gain[];
    voicePan?: Pan; analyzerNode?: Worklet; pitchNode?: ReturnType<typeof pitchNode>;
    voiceNodes?: ReturnType<typeof pitchNode>[];
  };
  const analyzer = state.analyzerNode;
  if (analyzer) {
    const shared = { frame: 1200, sourceMidi: 60, sourceHz: 261.625565, confidence: 0.99, voiced: true };
    if (fx.algorithm === 'robot') analyzer.port.onmessage?.({ data: { ...shared, type: 'robot-pitch-target', semitones: 7, targetMidi: 67 } });
    if (fx.algorithm.startsWith('hrm-')) analyzer.port.onmessage?.({ data: { ...shared, type: 'hrm-auto-target', target1: 4, target2: -128, voiceCount: 1 } });
    if (fx.algorithm === 'auto-riff') analyzer.port.onmessage?.({ data: { type: 'auto-riff-pitch', frame: 1200, semitones: 5 } });
  }
  const configure = analyzer ? Object.assign({}, analyzer.options.processorOptions?.parameters,
    ...analyzer.port.postMessage.mock.calls.map(([message]) => message.type === 'configure' ? message.parameters : {})) : null;
  return {
    configure,
    gains: [state.directGain, state.dryGain, state.wetGain, ...(state.voiceGains ?? []), ...(state.voiceMutes ?? [])].map(gain => gain?.gain.value ?? null),
    pan: state.voicePan?.pan.value ?? null,
    schedules: (state.pitchNode ? [state.pitchNode] : state.voiceNodes ?? []).map(node => node.setPitch.mock.calls.at(-1)),
  };
}
const publishedDefaults: Record<string, Record<string, number>> = {
  transpose: { official_trans: 0 },
  'pitch-bend': { official_pitch: 4, official_bend: 50 },
  robot: { official_note: 0, official_formant: 0 },
  'hrm-manual': { official_voice: 6, official_formant: 0, official_pan: 0, official_key: 0, official_d_level: 100, official_hrm_level: 80 },
  'hrm-auto': { official_voice: 4, official_formant: 0, official_pan: 0, official_hrm_mode: 1, official_key: 0, official_d_level: 100, official_hrm_level: 80 },
  octave: { official_octave: 0, official_oct_level: 50 },
  'auto-riff': { official_tempo: -1, official_hold: 0, official_attack: 50, official_loop: 0, official_key: 0, official_balance: 50 },
};
const snapshotCases = [
  { algorithm: 'transpose', controls: { official_trans: -7 } },
  { algorithm: 'pitch-bend', controls: { official_pitch: -3, official_bend: 70 } },
  { algorithm: 'robot', controls: { official_note: 7, official_formant: -25 } },
  { algorithm: 'hrm-manual', controls: { official_voice: 8, official_formant: 25, official_pan: -30, official_key: 2, official_d_level: 35, official_hrm_level: 75 } },
  { algorithm: 'hrm-auto', controls: { official_voice: 2, official_formant: -30, official_pan: 40, official_hrm_mode: 0, official_key: 5, official_d_level: 20, official_hrm_level: 65 } },
  { algorithm: 'octave', controls: { official_octave: 2, official_oct_level: 85 } },
  { algorithm: 'auto-riff', controls: { official_tempo: -1, official_hold: 1, official_attack: 80, official_loop: 1, official_key: 9, official_balance: 72 } },
];
describe('dedicated official parameter recovery', () => {
  afterEach(() => { harness.create.mockReset(); Worklet.instances = []; vi.unstubAllGlobals(); });
  it.each(snapshotCases)('$algorithm JSON snapshot restores effective DSP controls, gains and pitch scheduling', async ({ algorithm, controls }) => {
    prepare();
    const original = createSnapshotEffect(algorithm);
    if (algorithm === 'auto-riff') original.setParam('bpm', 93);
    for (const [key, value] of Object.entries(controls)) original.setParam(key, value!);
    await original.ready; original.setBypass(false);
    const expected = audibleState(original);
    expect(original.error).toBe(''); expect(original.processorReady).toBe(true);
    const snapshot = JSON.parse(JSON.stringify(original.getParameterSnapshot())) as Record<string, number>;
    const keys = Object.keys(snapshot); const firstOfficial = keys.findIndex(key => key.startsWith('official_'));
    expect(firstOfficial).toBeGreaterThan(0);
    expect(keys.slice(firstOfficial).every(key => key.startsWith('official_'))).toBe(true);
    expect(snapshot).toMatchObject(controls);
    const restored = createSnapshotEffect(algorithm);
    // Snapshot enumeration intentionally applies legacy state first, then the
    // official overlay. The overlay is authoritative where the units overlap.
    for (const [key, value] of Object.entries(snapshot)) restored.setParam(key, value);
    await restored.ready; restored.setBypass(false);
    expect(restored.error).toBe(''); expect(restored.processorReady).toBe(true);
    expect(restored.getParameterSnapshot()).toEqual(snapshot);
    expect(audibleState(restored)).toEqual(expected);
    expect(restored.error).toBe(''); expect(restored.processorReady).toBe(true);
    original.dispose(); restored.dispose();
  });
  it.each(snapshotCases)('$algorithm first official opt-in initializes only supported published defaults once', async ({ algorithm, controls }) => {
    prepare(); const fx = createSnapshotEffect(algorithm);
    const [key, value] = Object.entries(controls).at(-1)!;
    fx.setParam(key, value!); await fx.ready;
    expect(officialPitchDefaults(fx.name, algorithm)).toEqual(publishedDefaults[algorithm]);
    const expected = { ...publishedDefaults[algorithm], [key]: value };
    const official = () => Object.fromEntries(Object.entries(fx.getParameterSnapshot()).filter(([name]) => name.startsWith('official_')));
    expect(official()).toEqual(expected);
    expect(Object.keys(expected)).toHaveLength(BROWSER_OFFICIAL_PITCH_PARAMETER_KEYS[algorithm]!.length);
    const [secondKey, secondValue] = Object.entries(controls)[0]!;
    fx.setParam(secondKey, secondValue!);
    expect(official()).toEqual({ ...expected, [secondKey]: secondValue });
    expect(fx.error).toBe(''); fx.dispose();
  });
  it.each(snapshotCases.filter(({ algorithm }) => !['transpose', 'hrm-auto'].includes(algorithm)))('$algorithm direct macro preserves the official overlay', async ({ algorithm, controls }) => {
    prepare(); const fx = createSnapshotEffect(algorithm);
    for (const [key, value] of Object.entries(controls)) fx.setParam(key, value!);
    await fx.ready; fx.setBypass(false);
    const before = audibleState(fx);
    (fx as BrowserPitchBendFX).setAmount(0.15);
    expect(fx.getParameterSnapshot()).toMatchObject(controls);
    const after = audibleState(fx);
    expect(fx.error).toBe('');
    expect(after.configure).toEqual(before.configure);
    expect(after.schedules).toEqual(before.schedules);
    // ROBOT's macro remains its legacy dry/wet control; no official MIX exists.
    if (algorithm !== 'robot') expect(after.gains).toEqual(before.gains);
    fx.dispose();
  });
});
