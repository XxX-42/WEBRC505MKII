import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserAutoRiffDsp, type BrowserAutoRiffParameters } from '../../src/audio/fx/dsp/BrowserAutoRiffDsp';
import { FxProcessor } from '../../src/audio/worklet/FxProcessor';
import { findOfficialEffect, isOfficialRuntimeValueValid } from '../../src/audio/fx/official/parameters';

const pitchHarness = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('../../src/audio/pitch/signalsmith', () => ({ createLiveInputTransposeNode: pitchHarness.create }));
import { BrowserAutoRiffFX } from '../../src/audio/fx/BrowserAutoRiffFX';

const sampleRate = 8_000;
function render(parameters: BrowserAutoRiffParameters, seconds = 1.5, frequency = 220) {
  const dsp = new BrowserAutoRiffDsp(sampleRate, { bpm: 300, beatStepRate: 0.25, ...parameters });
  const frames: number[] = [];
  const pitches: number[] = [];
  const output = new Float32Array(Math.round(seconds * sampleRate));
  const gains = new Float32Array(output.length);
  for (let frame = 0; frame < output.length; frame += 1) {
    dsp.processSample(0.3 * Math.sin(2 * Math.PI * frequency * frame / sampleRate), frame);
    output[frame] = dsp.wetLeft;
    gains[frame] = dsp.attackGain;
    while (dsp.tryPopPitchChange()) {
      frames.push(dsp.lastPoppedFrame);
      pitches.push(dsp.lastPoppedSemitones);
    }
  }
  return { dsp, frames, pitches, output, gains };
}
function energy(samples: ArrayLike<number>, from = 0, end = samples.length): number {
  let sum = 0;
  for (let frame = from; frame < end; frame += 1) sum += samples[frame]! ** 2;
  return sum / Math.max(1, end - from);
}

class MockNode {
  readonly connect = vi.fn();
  readonly disconnect = vi.fn();
}
class MockGain extends MockNode {
  readonly gain = {
    value: 1,
    cancelScheduledValues: vi.fn(),
    setTargetAtTime: vi.fn((value: number) => { this.gain.value = value; }),
  };
}
class MockDelay extends MockNode { readonly delayTime = { value: 0 }; }
class MockWorklet extends MockNode {
  static instances: MockWorklet[] = [];
  readonly port = { postMessage: vi.fn(), onmessage: null as ((event: MessageEvent) => void) | null };
  constructor(_context: unknown, _name: string, readonly options: AudioWorkletNodeOptions) {
    super();
    MockWorklet.instances.push(this);
  }
}
function makeAdapter() {
  vi.stubGlobal('AudioWorkletNode', MockWorklet);
  const pitch = Object.assign(new MockNode(), {
    latencySeconds: 0.02, latencySamples: 960, setPitch: vi.fn(async () => undefined),
  });
  pitchHarness.create.mockResolvedValue(pitch);
  const context = {
    currentTime: 0, sampleRate: 48_000,
    createGain: () => new MockGain(), createDelay: () => new MockDelay(),
  } as unknown as AudioContext;
  const failure = vi.fn();
  return { fx: new BrowserAutoRiffFX(context, async () => undefined, failure), pitch, failure };
}

afterEach(() => {
  vi.unstubAllGlobals();
  pitchHarness.create.mockReset();
  MockWorklet.instances = [];
});

describe('AUTO RIFF official controls on the explicitly authored clean-room pattern', () => {
  it('uses the verified official domains without accepting an invented manual tempo or phrase ID', () => {
    const guide = findOfficialEffect('AUTO RIFF')!;
    expect(guide.page).toBe(36);
    expect(guide.parameters.map(parameter => parameter.key)).toEqual(['phrase', 'tempo', 'hold', 'attack', 'loop', 'key', 'balance']);
    const tempo = guide.parameters.find(parameter => parameter.key === 'tempo')!;
    expect(isOfficialRuntimeValueValid(tempo, -1)).toBe(true);
    expect(isOfficialRuntimeValueValid(tempo, 100)).toBe(true);
    expect(isOfficialRuntimeValueValid(tempo, 101)).toBe(false);
  });

  it('preserves legacy audio and tempo units until an official control is selected', () => {
    const { dsp, output, gains } = render({});
    expect(dsp.activeOfficialTempo).toBeUndefined();
    expect(dsp.activeKey).toBeUndefined();
    expect(dsp.stepFrames).toBe(400);
    expect(gains.every(value => value === 1)).toBe(true);
    for (let frame = 0; frame < output.length; frame += 1) {
      expect(output[frame]).toBeCloseTo(0.3 * Math.sin(2 * Math.PI * 220 * frame / sampleRate), 7);
    }
  });

  it('uses current BPM for note durations but not the authored 0..100 manual curve', () => {
    const dsp = new BrowserAutoRiffDsp(sampleRate, { bpm: 120, officialTempo: -1 });
    expect(dsp.stepFrames).toBe(4_000);
    dsp.setParameters({ bpm: 240 });
    expect(dsp.stepFrames).toBe(2_000);
    dsp.setParameters({ officialTempo: -16 });
    expect(dsp.stepFrames).toBe(32_000);
    dsp.setParameters({ officialTempo: 0 });
    expect(dsp.stepFrames).toBe(16_000);
    dsp.setParameters({ officialTempo: 100, bpm: 30 });
    expect(dsp.stepFrames).toBe(400);
    dsp.setParameters({ officialTempo: -0.125, bpm: 120 });
    expect(dsp.stepFrames).toBe(500);
    dsp.setParameters({ beatStepRate: 2 });
    expect(dsp.activeOfficialTempo).toBeUndefined();
    expect(dsp.stepFrames).toBe(8_000);
  });

  it('makes LOOP repeat the authored phrase, while OFF produces exactly one eight-step sequence', () => {
    const once = render({ loop: 0 });
    const repeating = render({ loop: 1 });
    expect(once.pitches).toHaveLength(8);
    expect(repeating.pitches.length).toBeGreaterThan(16);
    expect(repeating.pitches.slice(0, 8)).toEqual(repeating.pitches.slice(8, 16));
    for (let index = 1; index < repeating.frames.length; index += 1) {
      expect(repeating.frames[index]! - repeating.frames[index - 1]!).toBe(400);
    }
  });

  it('KEY changes actual pitch commands and compensates different tracked source notes', () => {
    const aInC = render({ key: 0 });
    const bInC = render({ key: 0 }, 1.5, 246.94165062806206);
    const aInD = render({ key: 2 });
    expect(aInC.pitches).toEqual([3, 7, 10, 14, 10, 7, 3, 0]);
    expect(bInC.pitches).toEqual(aInC.pitches.map(pitch => pitch - 2));
    expect(aInD.pitches).toEqual(aInC.pitches.map(pitch => pitch + 2));
  });

  it('HOLD latches audible stereo source audio across silence, continues sequencing, and releases cleanly', () => {
    const held = new BrowserAutoRiffDsp(sampleRate, { bpm: 300, beatStepRate: 0.25, loop: 1 });
    const live = new BrowserAutoRiffDsp(sampleRate, { bpm: 300, beatStepRate: 0.25, loop: 1 });
    const heldOutput = new Float32Array(8_000);
    const liveOutput = new Float32Array(8_000);
    let silenceCommands = 0;
    for (let frame = 0; frame < 8_000; frame += 1) {
      if (frame === 1_600) held.setParameters({ hold: 1 });
      const sample = frame < 3_200 ? 0.3 * Math.sin(2 * Math.PI * 220 * frame / sampleRate) : 0;
      held.processStereoSample(sample, sample * 0.5, frame);
      live.processSample(sample, frame);
      heldOutput[frame] = held.wetLeft;
      liveOutput[frame] = live.wetLeft;
      expect(held.wetRight).toBeCloseTo(held.wetLeft * 0.5, 7);
      while (held.tryPopPitchChange()) if (frame >= 4_000) silenceCommands += 1;
    }
    expect(held.sourceHeld).toBe(true);
    expect(held.hasPitch).toBe(false); // source tracker still honestly reports live-input silence
    expect(energy(heldOutput, 4_000)).toBeGreaterThan(0.035);
    expect(energy(liveOutput, 4_000)).toBe(0);
    expect(silenceCommands).toBeGreaterThan(4);
    held.setParameters({ hold: 0 });
    held.processStereoSample(0, 0, 8_000);
    expect(held.sourceHeld).toBe(false);
    expect(held.wetLeft).toBe(0);
    expect(held.step).toBe(-1);
  });

  it('HOLD armed before the first note still acquires a source and never invents sound from silence', () => {
    const dsp = new BrowserAutoRiffDsp(sampleRate, { hold: 1, loop: 1, officialTempo: 100 });
    for (let frame = 0; frame < 1_000; frame += 1) dsp.processSample(0, frame);
    expect(dsp.sourceHeld).toBe(false);
    expect(dsp.wetLeft).toBe(0);
    for (let frame = 1_000; frame < 3_000; frame += 1) {
      dsp.processSample(0.3 * Math.sin(2 * Math.PI * 220 * frame / sampleRate), frame);
    }
    expect(dsp.sourceHeld).toBe(true);
    expect(dsp.queueDepth).toBeGreaterThan(0);
    dsp.reset();
    expect(dsp.sourceHeld).toBe(false);
    expect(dsp.wetLeft).toBe(0);
    expect(dsp.queueDepth).toBe(0);
  });

  it('ATTACK adds an audible decaying loudness accent at each phrase start, not a fictitious rise time', () => {
    const plain = render({ attack: 0, loop: 1 });
    const accented = render({ attack: 100, loop: 1 });
    expect(accented.frames).toEqual(plain.frames);
    const start = accented.frames[0]!;
    expect(accented.gains[start]).toBe(2);
    expect(accented.gains[start + 240]).toBeCloseTo(1 + Math.exp(-1), 5);
    expect(energy(accented.output, start, start + 100)).toBeGreaterThan(energy(plain.output, start, start + 100) * 2.5);
    expect(accented.gains[accented.frames[8]!]).toBe(2);
    expect(accented.gains[start + 2_400]).toBeLessThan(1.001);
  });

  it('carries HOLD/ATTACK through the real core/worklet audio path and emits looped KEY commands', () => {
    const processor = new FxProcessor({ processorOptions: {
      algorithm: 'auto-riff', sampleRate, bypassed: false,
      parameters: { bpm: 120, autoRiffOfficialTempo: 100, autoRiffHold: 1, autoRiffAttack: 100, autoRiffLoop: 1, autoRiffKey: 0 },
    } });
    const messages = vi.fn();
    processor.port.postMessage = messages;
    const output = new Float32Array(8_000);
    for (let frame = 0; frame < output.length; frame += 100) {
      const input = new Float32Array(100);
      for (let offset = 0; offset < 100; offset += 1) {
        if (frame < 3_000) input[offset] = 0.3 * Math.sin(2 * Math.PI * 220 * (frame + offset) / sampleRate);
      }
      processor.process([[input]], [[output.subarray(frame, frame + 100), new Float32Array(100)]]);
    }
    expect(energy(output, 4_000)).toBeGreaterThan(0.035);
    const pitches = messages.mock.calls.map(([message]) => message).filter(message => message.type === 'auto-riff-pitch');
    expect(pitches.length).toBeGreaterThan(16);
    expect(pitches[0].semitones).toBe(3);
    expect(pitches[8].semitones).toBe(3);
    expect(pitches[1].frame - pitches[0].frame).toBe(400);
    expect(messages.mock.calls.some(([message]) => message.type === 'error')).toBe(false);
    processor.port.onmessage?.({ data: { type: 'configure', parameters: { autoRiffHold: 0 } } });
    const silence = new Float32Array(100);
    const released = new Float32Array(100);
    processor.process([[silence]], [[released, new Float32Array(100)]]);
    expect(energy(released)).toBe(0);
  });

  it('forwards real official fields while BALANCE changes the latency-aligned dry/wet audio routing', async () => {
    const { fx } = makeAdapter();
    await fx.ready;
    const analyzer = MockWorklet.instances[0]!;
    const internal = fx as unknown as { wetGain: MockGain; dryGain: MockGain; directGain: MockGain; dryDelay: MockDelay };
    for (const [key, value, field] of [
      ['tempo', -1, 'autoRiffOfficialTempo'], ['hold', 1, 'autoRiffHold'],
      ['attack', 100, 'autoRiffAttack'], ['loop', 1, 'autoRiffLoop'], ['key', 2, 'autoRiffKey'],
    ] as const) {
      fx.setParam(`official_${key}`, value);
      expect(analyzer.port.postMessage).toHaveBeenCalledWith({ type: 'configure', parameters: { [field]: value } });
      expect(fx.getParameterSnapshot()[`official_${key}`]).toBe(value);
    }
    fx.setBypass(false);
    fx.setParam('official_balance', 0);
    expect(internal.dryGain.gain.value).toBe(1);
    expect(internal.wetGain.gain.value).toBe(0);
    fx.setParam('official_balance', 100);
    expect(internal.dryGain.gain.value).toBe(0);
    expect(internal.wetGain.gain.value).toBe(1);
    expect(internal.directGain.gain.value).toBe(0);
    expect(fx.input.connect).toHaveBeenCalledWith(internal.dryDelay);
    expect(analyzer.connect).not.toHaveBeenCalledWith(internal.dryDelay); // wet source hold/accent never leaks into BALANCE=0
    expect(fx.getParameterSnapshot().official_balance).toBe(100);
    fx.dispose();
  });

  it('rejects invalid official domains and allows explicit legacy controls to resume their original units', async () => {
    const { fx } = makeAdapter();
    await fx.ready;
    for (const [key, value] of [['tempo', 101], ['tempo', -0.3], ['hold', 2], ['attack', 1.5], ['loop', -1], ['key', 12], ['balance', -1]] as const) {
      fx.setParam(`official_${key}`, value);
      expect(fx.error).toContain('documented domain');
      expect(fx.getParameterSnapshot()[`official_${key}`]).toBeUndefined();
    }
    fx.setParam('official_tempo', -1);
    fx.setParam('official_key', 0);
    fx.setParam('official_balance', 50);
    fx.setParam('rate_beats', 0.25);
    fx.setParam('scale', 2);
    fx.setParam('mix_percent', 80);
    expect(fx.getParameterSnapshot()).toMatchObject({ rate_beats: 0.25, scale: 2, mix_percent: 80 });
    expect(fx.getParameterSnapshot().official_tempo).toBeUndefined();
    expect(fx.getParameterSnapshot().official_key).toBeUndefined();
    expect(fx.getParameterSnapshot().official_balance).toBeUndefined();
    const dsp = new BrowserAutoRiffDsp(sampleRate, { key: 0, officialTempo: -1 });
    dsp.setParameters({ scale: 2, beatStepRate: 0.25 });
    expect(dsp.activeKey).toBeUndefined();
    expect(dsp.activeOfficialTempo).toBeUndefined();
    fx.dispose();
  });

  it('explicitly rejects every undocumented PHRASE and preserves that failure through asynchronous installation', async () => {
    const { fx, failure } = makeAdapter();
    fx.setParam('official_phrase', 0);
    expect(fx.error).toContain('proprietary phrase note data is not published');
    await fx.ready;
    expect(fx.processorReady).toBe(false);
    expect(fx.error).toContain('unsupported');
    for (const phrase of [0, 1, 15, 29]) {
      fx.setParam('official_phrase', phrase);
      expect(fx.error).toContain('not P1');
      expect(fx.getParameterSnapshot().official_phrase).toBeUndefined();
    }
    expect(failure).toHaveBeenCalled();
    const analyzer = MockWorklet.instances[0]!;
    expect(analyzer.port.postMessage.mock.calls.some(([message]) => 'autoRiffPhrase' in (message.parameters ?? {}))).toBe(false);
    fx.setParam('official_balance', 50);
    expect(fx.error).toContain('unsupported');
    expect(fx.processorReady).toBe(false);
    fx.setBypass(false);
    const routing = fx as unknown as { wetGain: MockGain; directGain: MockGain };
    expect(routing.wetGain.gain.value).toBe(0);
    expect(routing.directGain.gain.value).toBe(1);
    fx.dispose();
  });
});

it('AUTO RIFF MEAS follows master meter while note values and legacy beat units do not', () => {
 const three = render({ officialTempo: -4, quarterNotesPerMeasure: 3 }, 2.5);
 const four = render({ officialTempo: -4, quarterNotesPerMeasure: 4 }, 2.5);
 expect(three.frames[1]! - three.frames[0]!).toBe(4800);
 expect(four.frames[1]! - four.frames[0]!).toBe(6400);
 expect(render({ officialTempo: -1, quarterNotesPerMeasure: 3 }).frames).toEqual(render({ officialTempo: -1, quarterNotesPerMeasure: 4 }).frames);
 expect(render({ quarterNotesPerMeasure: 3 }).output).toEqual(render({ quarterNotesPerMeasure: 4 }).output);
});
