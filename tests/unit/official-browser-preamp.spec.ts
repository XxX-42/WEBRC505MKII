import { describe, expect, it } from 'vitest';
import {
  BrowserPreampDsp,
  type BrowserPreampOfficialParameters,
} from '../../src/audio/fx/dsp/BrowserPreampDsp';

const SAMPLE_RATE = 48000;
const DEFAULTS: Required<BrowserPreampOfficialParameters> = {
  ampType: 3, spkType: 1, gain: 50, tComp: 0,
  bass: 50, middle: 50, treble: 50, presence: 50,
  micType: 0, micDis: 0, micPos: 0,
};

function signal(frame: number, sampleRate = SAMPLE_RATE): number {
  const envelope = 0.15 + 0.85 * (Math.sin(frame * 0.0007) ** 2);
  return envelope * (
    0.19 * Math.sin(2 * Math.PI * 97 * frame / sampleRate)
    + 0.13 * Math.sin(2 * Math.PI * 731 * frame / sampleRate)
    + 0.09 * Math.sin(2 * Math.PI * 2879 * frame / sampleRate)
    + 0.06 * Math.sin(2 * Math.PI * 6809 * frame / sampleRate)
  );
}

function render(
  parameters: BrowserPreampOfficialParameters,
  frames = 8192,
  sampleRate = SAMPLE_RATE,
  waveform: (frame: number) => number = (frame) => signal(frame, sampleRate),
): Float32Array {
  const dsp = new BrowserPreampDsp(sampleRate);
  dsp.setOfficialParameters({ ...DEFAULTS, ...parameters });
  return renderProcessor(dsp, frames, waveform);
}

function renderProcessor(dsp: BrowserPreampDsp, frames: number, waveform = (frame: number) => signal(frame)): Float32Array {
  const output = new Float32Array(frames * 2);
  for (let frame = 0; frame < frames; frame += 1) {
    dsp.processSample(waveform(frame), waveform(frame + 153));
    output[2 * frame] = dsp.outputLeft;
    output[2 * frame + 1] = dsp.outputRight;
  }
  return output;
}

function rms(samples: Float32Array): number {
  let square = 0;
  for (const sample of samples) square += sample * sample;
  return Math.sqrt(square / samples.length);
}

function difference(left: Float32Array, right: Float32Array): number {
  let square = 0;
  for (let index = 0; index < left.length; index += 1) square += (left[index]! - right[index]!) ** 2;
  return Math.sqrt(square / left.length) / Math.max(1e-12, rms(left), rms(right));
}

function floatHash(data: Float32Array): number {
  let hash = 2166136261;
  for (const word of new Uint32Array(data.buffer)) hash = Math.imul(hash ^ word, 16777619) >>> 0;
  return hash;
}

describe('Official Browser PREAMP authored amp, speaker and microphone controls', () => {
  it('uses every manual default when any finite official value activates the hook', () => {
    const implicit = new BrowserPreampDsp(SAMPLE_RATE);
    implicit.setOfficialParameters({ gain: 50 });
    const explicit = new BrowserPreampDsp(SAMPLE_RATE);
    explicit.setOfficialParameters(DEFAULTS);
    expect(renderProcessor(implicit, 4096)).toEqual(renderProcessor(explicit, 4096));
  });

  it.each([
    ['ampType', 0, 8], ['spkType', 0, 8], ['gain', 0, 120], ['tComp', -10, 10],
    ['bass', 0, 100], ['middle', 0, 100], ['treble', 0, 100], ['presence', 0, 100],
    ['micType', 0, 4], ['micDis', 0, 1], ['micPos', 0, 10],
  ] as const)('%s independently changes the rendered signal over its complete official range', (key, low, high) => {
    const minimum = render({ [key]: low });
    const maximum = render({ [key]: high });
    expect(difference(minimum, maximum)).toBeGreaterThan(0.005);
  });

  it.each([
    ['ampType', 9, { spkType: 0 }],
    ['spkType', 9, {}],
    ['micType', 5, { spkType: 5, micDis: 1 }],
    ['micPos', 11, { spkType: 4, micDis: 1 }],
  ] as const)('every %s selection has a distinct DSP response', (key, count, extra) => {
    const outputs = Array.from({ length: count }, (_, value) => render({ ...extra, [key]: value }, 4096));
    expect(new Set(outputs.map(floatHash)).size).toBe(count);
    for (let a = 0; a < count; a += 1) {
      for (let b = a + 1; b < count; b += 1) {
        expect(difference(outputs[a]!, outputs[b]!), `${key} ${a}/${b}`).toBeGreaterThan(0.0005);
      }
    }
  });

  it('makes ORIGINAL follow AMP TYPE without changing explicitly selected cabinet profiles', () => {
    // An impulse through the cabinet after a tiny excitation approximates a
    // linear transfer. ORIGINAL is authored to follow the selected amplifier;
    // the fixed speaker options are independent, beyond amp-stage voicing.
    const cabinet = (ampType: number, spkType: number): Float32Array => render({
      ampType, spkType, gain: 0, tComp: -10, micType: 4, micDis: 1,
    }, 1024, SAMPLE_RATE, (frame) => frame === 0 ? 0.0001 : 0);
    const aOriginal = cabinet(0, 1);
    const aFixed = cabinet(0, 4);
    const bOriginal = cabinet(8, 1);
    const bFixed = cabinet(8, 4);
    expect(difference(aOriginal, aFixed)).toBeGreaterThan(0.03);
    expect(difference(bOriginal, bFixed)).toBeGreaterThan(0.03);
    // Distinct choice, not just one fixed cabinet reused for ORIGINAL.
    expect(difference(aOriginal, bOriginal)).toBeGreaterThan(difference(aFixed, bFixed));
  });

  it('SPK OFF bypasses all microphone type, distance and position processing exactly', () => {
    const reference = render({ spkType: 0, micType: 0, micDis: 0, micPos: 0 }, 4096);
    for (let microphone = 0; microphone < 5; microphone += 1) {
      expect(render({ spkType: 0, micType: microphone, micDis: 1, micPos: 10 }, 4096)).toEqual(reference);
    }
    expect(difference(reference, render({ spkType: 4, micType: 4, micDis: 1, micPos: 0 }, 4096))).toBeGreaterThan(0.05);
  });

  it('stores microphone changes while OFF and applies them when the speaker is enabled', () => {
    const actual = new BrowserPreampDsp(SAMPLE_RATE);
    actual.setOfficialParameters({ ...DEFAULTS, spkType: 0 });
    actual.setOfficialParameters({ micType: 3, micDis: 1, micPos: 7 });
    actual.setOfficialParameters({ spkType: 6 });
    actual.reset();
    expect(renderProcessor(actual, 4096)).toEqual(render({ spkType: 6, micType: 3, micDis: 1, micPos: 7 }, 4096));
  });

  it('T-COMP is level-dependent, with real detector memory, rather than a static volume setting', () => {
    const quiet = (frame: number) => 0.002 * Math.sin(frame * 0.11);
    const loud = (frame: number) => 0.4 * Math.sin(frame * 0.11);
    const controls = { ampType: 0, spkType: 0, gain: 10 };
    expect(render({ ...controls, tComp: -10 }, 8192, SAMPLE_RATE, quiet))
      .toEqual(render({ ...controls, tComp: 10 }, 8192, SAMPLE_RATE, quiet));
    const less = render({ ...controls, tComp: -10 }, 8192, SAMPLE_RATE, loud);
    const more = render({ ...controls, tComp: 10 }, 8192, SAMPLE_RATE, loud);
    expect(rms(more)).toBeLessThan(rms(less) * 0.85);
    // A preceding loud segment changes gain on a following below-threshold
    // probe, proving attack/release state survives beyond the instantaneous input.
    const dsp = new BrowserPreampDsp(SAMPLE_RATE);
    dsp.setOfficialParameters({ ...DEFAULTS, ...controls, tComp: 10 });
    for (let frame = 0; frame < 4096; frame += 1) dsp.processSample(loud(frame), loud(frame));
    const afterLoud = renderProcessor(dsp, 512, quiet).slice(256);
    const freshQuiet = render({ ...controls, tComp: 10 }, 512, SAMPLE_RATE, quiet).slice(256);
    expect(rms(afterLoud)).toBeLessThan(rms(freshQuiet) * 0.9);
  });

  it('GAIN 120 is not silently clamped to the legacy maximum 100', () => {
    const input = (frame: number) => 0.035 * Math.sin(frame * 0.067);
    const at100 = render({ ampType: 2, spkType: 0, gain: 100 }, 4096, SAMPLE_RATE, input);
    const at120 = render({ ampType: 2, spkType: 0, gain: 120 }, 4096, SAMPLE_RATE, input);
    expect(difference(at100, at120)).toBeGreaterThan(0.025);
    expect(render({ ampType: 2, spkType: 0, gain: 200 }, 4096, SAMPLE_RATE, input)).toEqual(at120);
  });

  it('ignores invalid updates and clamps all manual controls at their own limits', () => {
    const endpoints = render({ ampType: 8, spkType: 8, gain: 120, tComp: -10, bass: 0, middle: 100,
      treble: 0, presence: 100, micType: 4, micDis: 1, micPos: 10 }, 4096);
    expect(render({ ampType: 999, spkType: 999, gain: 999, tComp: -999, bass: -999, middle: 999,
      treble: -999, presence: 999, micType: 999, micDis: 999, micPos: 999 }, 4096)).toEqual(endpoints);
    const dsp = new BrowserPreampDsp(SAMPLE_RATE);
    dsp.setOfficialParameters(DEFAULTS);
    dsp.setOfficialParameters({ ampType: NaN, spkType: Infinity, gain: NaN, tComp: -Infinity,
      bass: undefined, middle: NaN, treble: Infinity, presence: NaN, micType: Infinity, micDis: NaN, micPos: NaN });
    expect(renderProcessor(dsp, 4096)).toEqual(render(DEFAULTS, 4096));
  });

  it('gives official controls priority over all later legacy updates, without resetting ramps', () => {
    const actual = new BrowserPreampDsp(SAMPLE_RATE);
    const expected = new BrowserPreampDsp(SAMPLE_RATE);
    for (const dsp of [actual, expected]) {
      dsp.setOfficialParameters({ ...DEFAULTS, ampType: 0, gain: 0 });
      dsp.setOfficialParameters({ ampType: 8, gain: 120, presence: 75, micPos: 6 });
    }
    for (let frame = 0; frame < 4096; frame += 1) {
      if (frame % 64 === 0) {
        actual.setParameters({ model: 0, gainPercent: 0, levelDb: 12, bassDb: -12, middleDb: 12, trebleDb: -12 });
        actual.setOfficialParameters({ ampType: 8, gain: 120, presence: 75, micPos: 6 });
      }
      actual.processSample(signal(frame), signal(frame + 153));
      expected.processSample(signal(frame), signal(frame + 153));
      expect(actual.outputLeft).toBe(expected.outputLeft);
      expect(actual.outputRight).toBe(expected.outputRight);
    }
  });

  it('resets histories and in-flight ramps deterministically to the latest targets', () => {
    const dsp = new BrowserPreampDsp(SAMPLE_RATE);
    dsp.setOfficialParameters(DEFAULTS);
    renderProcessor(dsp, 777);
    const targets = { ...DEFAULTS, ampType: 7, spkType: 8, gain: 110, tComp: 9,
      bass: 75, middle: 35, treble: 90, presence: 80, micType: 3, micDis: 1, micPos: 9 };
    dsp.setOfficialParameters(targets);
    renderProcessor(dsp, 211);
    dsp.reset();
    expect(dsp.outputLeft).toBe(0);
    expect(dsp.outputRight).toBe(0);
    expect(renderProcessor(dsp, 4096)).toEqual(render(targets, 4096));
    dsp.reset();
    for (let frame = 0; frame < 512; frame += 1) {
      dsp.processSample(0, 0);
      expect(dsp.outputLeft).toBe(0);
      expect(dsp.outputRight).toBe(0);
    }
  });

  it.each([8000, 44100, 48000, 96000])('is chunk-invariant, finite and bounded through extreme controls at %i Hz', (sampleRate) => {
    const process = (chunks: readonly number[]) => {
      const dsp = new BrowserPreampDsp(sampleRate);
      dsp.setOfficialParameters({ ...DEFAULTS, ampType: 8, spkType: 8, gain: 120, tComp: 10,
        bass: 100, middle: 100, treble: 100, presence: 100, micType: 2, micDis: 1 });
      const output = new Float32Array(4096 * 2);
      let frame = 0;
      let chunk = 0;
      while (frame < 4096) {
        const end = Math.min(4096, frame + chunks[chunk % chunks.length]!);
        while (frame < end) {
          if (frame === 777) dsp.setOfficialParameters({ ampType: 0, spkType: 0, gain: 0, tComp: -10 });
          if (frame === 1201) dsp.setOfficialParameters({ ampType: 6, spkType: 5, gain: 120, micPos: 10 });
          if (frame === 2381) dsp.reset();
          const left = frame % 401 === 0 ? NaN : frame % 617 === 0 ? Infinity : 8 * signal(frame, sampleRate);
          const right = frame % 503 === 0 ? -Infinity : frame % 101 === 0 ? 1e300 : -left;
          dsp.processSample(left, right);
          output[2 * frame] = dsp.outputLeft;
          output[2 * frame + 1] = dsp.outputRight;
          frame += 1;
        }
        chunk += 1;
      }
      return output;
    };
    const whole = process([4096]);
    expect(process([1, 7, 64, 127, 257, 3, 511])).toEqual(whole);
    expect(whole.every((value) => Number.isFinite(value) && Math.abs(value) <= 4)).toBe(true);
  });
});

describe('Official PREAMP preserves the legacy five-model path exactly', () => {
  it('does not activate for empty, all-undefined, or all-invalid official updates', () => {
    const expected = new BrowserPreampDsp(SAMPLE_RATE, { model: 4, gainPercent: 83, bassDb: 6, levelDb: -2 });
    const actual = new BrowserPreampDsp(SAMPLE_RATE, { model: 4, gainPercent: 83, bassDb: 6, levelDb: -2 });
    actual.setOfficialParameters({});
    actual.setOfficialParameters({ ampType: undefined, spkType: undefined, gain: undefined, tComp: undefined,
      bass: undefined, middle: undefined, treble: undefined, presence: undefined,
      micType: undefined, micDis: undefined, micPos: undefined });
    actual.setOfficialParameters({ ampType: NaN, spkType: Infinity, gain: NaN, tComp: -Infinity });
    expect(renderProcessor(actual, 4096)).toEqual(renderProcessor(expected, 4096));
  });

  it.each([
    [8000, [3958196636, 3422601330, 345946723, 4183480322, 1315224949]],
    [44100, [3497464878, 874921041, 60695875, 636660622, 4091098009]],
    [48000, [737271398, 781265850, 886382337, 2807647504, 2001295906]],
  ] as const)('matches pre-change Float32 hashes across automation and reset at %i Hz', (sampleRate, hashes) => {
    for (let model = 0; model < 5; model += 1) {
      const dsp = new BrowserPreampDsp(sampleRate, { model, gainPercent: 72, bassDb: 3, middleDb: -2, trebleDb: 4, levelDb: -1 });
      const output = new Float32Array(4096 * 2);
      for (let frame = 0; frame < 4096; frame += 1) {
        if (frame === 511) dsp.setParameters({ model: 4 - model, gainPercent: 100, bassDb: -4, middleDb: 5, trebleDb: -3, levelDb: 1 });
        if (frame === 1703) dsp.setParameters({ model: 2, gainPercent: 0, levelDb: 0 });
        if (frame === 2381) dsp.reset();
        const scale = frame > 3600 ? 0.3 : frame > 3000 ? 1e-14 : frame > 2600 ? 0 : 0.3;
        dsp.processSample(scale * Math.sin(2 * Math.PI * 317 * frame / sampleRate), scale * Math.cos(2 * Math.PI * 911 * frame / sampleRate));
        output[2 * frame] = dsp.outputLeft;
        output[2 * frame + 1] = dsp.outputRight;
      }
      expect(floatHash(output), `model ${model}`).toBe(hashes[model]);
    }
  });
});
