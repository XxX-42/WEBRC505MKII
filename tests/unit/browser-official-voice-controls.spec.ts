import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { BrowserElectricDsp } from '../../src/audio/fx/dsp/BrowserElectricDsp';
import { BrowserOscBotCore } from '../../src/audio/fx/BrowserOscBotCore';
import { BrowserOscVocCore } from '../../src/audio/fx/BrowserOscVocCore';
import { BrowserVocoderCore } from '../../src/audio/fx/vocoder/BrowserVocoderCore';
import { BrowserOfficialVoiceOscillator } from '../../src/audio/fx/dsp/BrowserOfficialVoiceDsp';

const SR = 48_000;
const N = 24_000;
type OfficialControls = Record<string, number>;
type VoiceProcessor = { setOfficialParameters(p: OfficialControls): void; processSample(l: number, r: number): unknown; readonly outputLeft: number; reset(): void };
const factories = {
  electric: () => new BrowserElectricDsp(SR),
  vocoder: () => new BrowserVocoderCore(SR),
  oscVoc: () => { const core = new BrowserOscVocCore(SR); core.noteOn(1, 57, 127, 0); return core; },
  oscBot: () => new BrowserOscBotCore(SR),
};
const defaults = {
  electric: { shift: 0, formant: 0, speed: 5, stability: 0, scale: 0 },
  vocoder: { tone: 0, attack: 50, mod_sens: 0 },
  oscVoc: { carrier: 0, tone: 0, attack: 50, octave: 2, mod_sens: 0, release: 50 },
  oscBot: { osc: 0, tone: 0, attack: 50, note: 36, mod_sens: 0 },
};
const ranges = {
  electric: { shift: [-12, 12], formant: [-50, 50], speed: [0, 10], stability: [-10, 10], scale: [0, 12] },
  vocoder: { tone: [-50, 50], attack: [0, 100], mod_sens: [-50, 50] },
  oscVoc: { carrier: [0, 4], tone: [-50, 50], attack: [0, 100], octave: [0, 3], mod_sens: [-50, 50], release: [0, 100] },
  oscBot: { osc: [0, 4], tone: [-50, 50], attack: [0, 100], note: [24, 127], mod_sens: [-50, 50] },
} as const;
function sample(i: number): number {
  return 0.23 * Math.sin(2 * Math.PI * 220 * i / SR) + 0.08 * Math.sin(2 * Math.PI * 880 * i / SR) + 0.04 * Math.sin(2 * Math.PI * 2640 * i / SR);
}
function render(core: VoiceProcessor, frames = N, input = sample): Float64Array {
  const output = new Float64Array(frames);
  for (let i = 0; i < frames; i++) { const x = input(i); core.processSample(x, x); output[i] = core.outputLeft; }
  return output;
}
function energy(output: ArrayLike<number>, from = 0, to = output.length): number {
  let sum = 0; for (let i = from; i < to; i++) sum += output[i]! ** 2; return sum;
}
function delta(a: ArrayLike<number>, b: ArrayLike<number>, start = 0): number {
  let sum = 0; for (let i = start; i < Math.min(a.length, b.length); i++) sum += (a[i]! - b[i]!) ** 2; return sum;
}
function magnitude(output: ArrayLike<number>, frequency: number, from = 0): number {
  let real = 0; let imaginary = 0;
  for (let i = from; i < output.length; i++) { const phase = 2 * Math.PI * frequency * i / SR; real += output[i]! * Math.cos(phase); imaginary += output[i]! * Math.sin(phase); }
  return 2 * Math.hypot(real, imaginary) / (output.length - from);
}

describe('official Browser voice parameter domains', () => {
  for (const effect of Object.keys(factories) as (keyof typeof factories)[]) {
    it(`${effect}: accepts every boundary/enum and rejects invalid updates atomically`, () => {
      const processor = factories[effect]();
      for (const [key, [min, max]] of Object.entries(ranges[effect])) {
        for (let value = min; value <= max; value++) expect(() => processor.setOfficialParameters({ [key]: value })).not.toThrow();
        for (const value of [min - 1, max + 1, min + 0.5, NaN, Infinity, -Infinity]) {
          expect(() => processor.setOfficialParameters({ [key]: value })).toThrow(RangeError);
        }
      }
      const a = factories[effect](); const b = factories[effect]();
      a.setOfficialParameters(defaults[effect]); b.setOfficialParameters(defaults[effect]);
      expect(() => a.setOfficialParameters({ ...defaults[effect], definitely_unsupported: 0 })).toThrow(RangeError);
      expect(render(a, 4000)).toEqual(render(b, 4000));
    });
    it(`${effect}: first partial edit applies documented defaults; empty edits preserve legacy`, () => {
      const a = factories[effect](); const b = factories[effect]();
      const [key, value] = Object.entries(defaults[effect])[0]!;
      a.setOfficialParameters({ [key]: value }); b.setOfficialParameters(defaults[effect]);
      expect(render(a, 6000)).toEqual(render(b, 6000));
      const legacy = factories[effect](); const untouched = factories[effect]();
      legacy.setOfficialParameters({});
      expect(render(legacy, 4000)).toEqual(render(untouched, 4000));
    });
    it(`${effect}: reapplying the same controls does not retrigger envelopes or oscillator phase`, () => {
      const a = factories[effect](); const b = factories[effect]();
      a.setOfficialParameters(defaults[effect]); b.setOfficialParameters(defaults[effect]);
      expect(render(a, 6000)).toEqual(render(b, 6000));
      a.setOfficialParameters(defaults[effect]);
      expect(render(a, 6000)).toEqual(render(b, 6000));
    });
  }
  it('does not pretend the missing physical vocoder carrier bus is available', () => {
    const core = new BrowserVocoderCore(SR);
    expect(() => core.setOfficialParameters({ carrier: 0 } as never)).toThrow(RangeError);
    expect(() => core.setOfficialParameters({ carrier_thru: 1 } as never)).toThrow(RangeError);
    expect(() => core.setOfficialParameters({ formant: 0 } as never)).toThrow(RangeError);
    expect(() => core.setOfficialParameters({ release: 50 } as never)).toThrow(RangeError);
  });
});

describe('official Browser voice audio behavior', () => {
  it('all five oscillator choices have distinct signals and harmonic spectra', () => {
    const outputs: Float64Array[] = [];
    for (let waveform = 0; waveform < 5; waveform++) {
      const oscillator = new BrowserOfficialVoiceOscillator(SR);
      oscillator.setFrequency(240); oscillator.setWaveform(waveform as 0 | 1 | 2 | 3 | 4);
      const output = new Float64Array(N);
      for (let i = 0; i < N; i++) output[i] = oscillator.processSample();
      outputs.push(output);
    }
    for (let a = 0; a < 5; a++) for (let b = a + 1; b < 5; b++) expect(delta(outputs[a]!, outputs[b]!)).toBeGreaterThan(10);
    const ratio = (wave: number, harmonic: number) => magnitude(outputs[wave]!, 240 * harmonic) / magnitude(outputs[wave]!, 240);
    expect(ratio(0, 2)).toBeGreaterThan(0.45);
    expect(ratio(1, 2)).toBeLessThan(ratio(0, 2) * 0.8);
    expect(ratio(3, 2)).toBeLessThan(0.001);
    expect(ratio(4, 2)).toBeGreaterThan(0.5);
    // Use the fifth harmonic to resolve seven-cent sidebands in a half-second window.
    expect(magnitude(outputs[2]!, 1200 * 2 ** (7 / 1200))).toBeGreaterThan(magnitude(outputs[0]!, 1200 * 2 ** (7 / 1200)));
  });
  for (const effect of ['vocoder', 'oscVoc', 'oscBot'] as const) {
    it(`${effect}: TONE and MOD SENS affect spectral balance and modulation gain`, () => {
      const make = (parameter: string, value: number) => { const core = factories[effect](); core.setOfficialParameters({ ...defaults[effect], [parameter]: value }); return render(core); };
      const dark = make('tone', -50); const bright = make('tone', 50);
      expect(delta(dark, bright, 4000)).toBeGreaterThan(0.1);
      expect(magnitude(bright, 2640, 4000) / Math.max(1e-10, magnitude(bright, 220, 4000)))
        .toBeGreaterThan(magnitude(dark, 2640, 4000) / Math.max(1e-10, magnitude(dark, 220, 4000)));
      expect(energy(make('mod_sens', 50), 4000)).toBeGreaterThan(energy(make('mod_sens', -50), 4000) * 10);
    });
    it(`${effect}: ATTACK changes actual onset response`, () => {
      const make = (attack: number) => { const core = factories[effect](); core.setOfficialParameters({ ...defaults[effect], attack }); return render(core, 2400); };
      expect(energy(make(0), 0, 1200)).toBeGreaterThan(energy(make(100), 0, 1200) * 3);
    });
  }
  it('OSC VOC octave ordinals transpose MIDI notes exactly and RELEASE controls the note-off tail', () => {
    for (let octave = 0; octave < 4; octave++) {
      const core = new BrowserOscVocCore(SR); core.setOfficialParameters({ octave }); core.noteOn(1, 69, 127, 0); core.processSample(0.1);
      expect(core.targetFrequencyHz).toBeCloseTo(440 * 2 ** (octave - 2), 8);
    }
    const make = (release: number) => {
      const core = new BrowserOscVocCore(SR); core.setOfficialParameters({ release }); core.noteOn(1, 57, 127, 0); core.noteOff(1, 57, 12000);
      return render(core);
    };
    expect(energy(make(100), 16000)).toBeGreaterThan(energy(make(0), 16000) * 100);
  });
  it('OSC BOT NOTE selects a real fixed-pitch carrier independent of legacy pattern', () => {
    const a = new BrowserOscBotCore(SR, { pattern: 0 }); const b = new BrowserOscBotCore(SR, { pattern: 7 });
    a.setOfficialParameters({ note: 69 }); b.setOfficialParameters({ note: 69 });
    expect(a.targetFrequencyHz).toBe(440);
    expect(render(a)).toEqual(render(b));
    for (const note of [24, 36, 60, 127]) { a.setOfficialParameters({ note }); expect(a.targetFrequencyHz).toBeCloseTo(440 * 2 ** ((note - 69) / 12), 8); }
    const low = new BrowserOscBotCore(SR); const high = new BrowserOscBotCore(SR);
    low.setOfficialParameters({ note: 57 }); high.setOfficialParameters({ note: 69 });
    expect(delta(render(low), render(high), 4000)).toBeGreaterThan(1);
  });
  it('five official waveform choices propagate through both OSC vocoder paths', () => {
    for (const effect of ['oscVoc', 'oscBot'] as const) {
      const outputs = Array.from({ length: 5 }, (_, waveform) => { const core = factories[effect](); core.setOfficialParameters({ ...defaults[effect], [effect === 'oscVoc' ? 'carrier' : 'osc']: waveform }); return render(core, 12000); });
      for (let a = 0; a < 5; a++) for (let b = a + 1; b < 5; b++) expect(delta(outputs[a]!, outputs[b]!, 4000)).toBeGreaterThan(0.001);
    }
  });
  it('ELECTRIC SHIFT transposes; SCALE constrains detected pitch to its pitch classes', () => {
    const tone = (i: number) => 0.3 * Math.sin(2 * Math.PI * 277.18263 * i / SR);
    const chromatic = new BrowserElectricDsp(SR); chromatic.setOfficialParameters({ shift: 0 }); render(chromatic, N, tone);
    const shifted = new BrowserElectricDsp(SR); shifted.setOfficialParameters({ shift: 12 }); render(shifted, N, tone);
    expect(chromatic.targetPitchHz).toBeCloseTo(277.18263, 3);
    expect(shifted.targetPitchHz).toBeCloseTo(chromatic.targetPitchHz * 2, 6);
    const cMajor = new BrowserElectricDsp(SR); cMajor.setOfficialParameters({ scale: 1 }); render(cMajor, N, tone);
    const midi = Math.round(69 + 12 * Math.log2(cMajor.targetPitchHz / 440));
    expect([0, 2, 4, 5, 7, 9, 11]).toContain(midi % 12);
    expect(cMajor.targetPitchHz).not.toBeCloseTo(chromatic.targetPitchHz, 2);
  });
  it('ELECTRIC SPEED changes correction time and STABILITY creates note-selection hysteresis', () => {
    const fast = new BrowserElectricDsp(SR); const slow = new BrowserElectricDsp(SR);
    fast.setOfficialParameters({ speed: 10 }); slow.setOfficialParameters({ speed: 0 });
    render(fast, 12000); render(slow, 12000); fast.setOfficialParameters({ shift: 12 }); slow.setOfficialParameters({ shift: 12 });
    render(fast, 400); render(slow, 400);
    expect(fast.currentPitchHz).toBeGreaterThan(slow.currentPitchHz * 1.5);
    const loose = new BrowserElectricDsp(SR); const stable = new BrowserElectricDsp(SR);
    loose.setOfficialParameters({ stability: -10 }); stable.setOfficialParameters({ stability: 10 });
    const tone = (hz: number) => (i: number) => 0.3 * Math.sin(2 * Math.PI * hz * i / SR);
    render(loose, 12000, tone(440)); render(stable, 12000, tone(440));
    render(loose, 16000, tone(440 * 2 ** (0.65 / 12))); render(stable, 16000, tone(440 * 2 ** (0.65 / 12)));
    expect(loose.targetPitchHz).toBeCloseTo(466.16376, 3); expect(stable.targetPitchHz).toBeCloseTo(440, 3);
  });
  it('ELECTRIC FORMANT moves the resynthesis envelope without transposing the oscillator', () => {
    const low = new BrowserElectricDsp(SR); const high = new BrowserElectricDsp(SR);
    low.setOfficialParameters({ formant: -50 }); high.setOfficialParameters({ formant: 50 });
    const a = render(low); const b = render(high);
    expect(low.targetPitchHz).toBeCloseTo(high.targetPitchHz, 10);
    expect(delta(a, b, 6000)).toBeGreaterThan(1);
    const filterbank = new BrowserVocoderCore(SR); const center = filterbank.getBandCenterFrequencyHz(5);
    filterbank.setVoiceShapingParameters({ formant: -50 }); expect(filterbank.getCarrierBandCenterFrequencyHz(5)).toBeCloseTo(center / 2, 8);
    filterbank.setVoiceShapingParameters({ formant: 50 }); expect(filterbank.getCarrierBandCenterFrequencyHz(5)).toBeCloseTo(center * 2, 8);
  });
});

describe('official Browser voice render safety', () => {
  it('allocates no typed arrays or Array/Object collections in the hot render paths', () => {
    const cores = Object.values(factories).map(make => make());
    cores.forEach((core, index) => core.setOfficialParameters(Object.values(defaults)[index]!));
    const traps = ['Float32Array', 'Float64Array', 'Int32Array', 'Uint32Array', 'Array'] as const;
    for (const name of traps) vi.stubGlobal(name, function () { throw new Error(`render allocated ${name}`); });
    const objectKeys = vi.spyOn(Object, 'keys').mockImplementation(() => { throw new Error('render enumerated object'); });
    const objectValues = vi.spyOn(Object, 'values').mockImplementation(() => { throw new Error('render enumerated object'); });
    try {
      for (let i = 0; i < 10000; i++) for (const core of cores) core.processSample(sample(i), sample(i));
    } finally { objectKeys.mockRestore(); objectValues.mockRestore(); vi.unstubAllGlobals(); }
    for (const file of ['BrowserOfficialVoiceDsp.ts', 'BrowserElectricDsp.ts']) {
      const source = readFileSync(`${process.cwd()}/src/audio/fx/dsp/${file}`, 'utf8');
      const start = source.indexOf('  processSample(');
      const end = source.indexOf('\n  reset(', start);
      expect(source.slice(start, end > start ? end : undefined)).not.toMatch(/new (?:Array|Float\d+Array|Object)\s*\(/);
    }
  });
  it('official MIDI processing is invariant to arbitrary callback sizes and scheduled note changes', () => {
    const make = () => {
      const core = new BrowserOscVocCore(SR);
      core.setOfficialParameters({ carrier: 2, tone: 20, attack: 17, octave: 1, mod_sens: 11, release: 70 });
      core.noteOn(1, 57, 127, 0); core.noteOn(1, 64, 99, 2345); core.noteOff(1, 64, 5888); core.noteOff(1, 57, 9000);
      return core;
    };
    const frames = 12347;
    const input = Float32Array.from({ length: frames }, (_, i) => sample(i));
    const a = make(); const b = make();
    const wholeLeft = new Float32Array(frames); const wholeRight = new Float32Array(frames);
    a.processBlock(input, input, wholeLeft, wholeRight, frames);
    const chunked = new Float32Array(frames); const sizes = [1, 17, 128, 257, 31, 511, 73];
    let offset = 0; let part = 0;
    while (offset < frames) {
      const count = Math.min(sizes[part++ % sizes.length]!, frames - offset);
      const left = new Float32Array(count); const right = new Float32Array(count);
      b.processBlock(input.subarray(offset, offset + count), input.subarray(offset, offset + count), left, right, count);
      chunked.set(left, offset); offset += count;
    }
    expect(chunked).toEqual(wholeLeft);
  });
  it('extreme official settings stay bounded across supported sample rates', () => {
    for (const sampleRate of [8000, 44100, 96000, 192000]) {
      const electric = new BrowserElectricDsp(sampleRate); electric.setOfficialParameters({ shift: 12, formant: 50, speed: 10, stability: -10, scale: 12 });
      const vocoder = new BrowserVocoderCore(sampleRate); vocoder.setOfficialParameters({ tone: 50, attack: 0, mod_sens: 50 });
      const oscVoc = new BrowserOscVocCore(sampleRate); oscVoc.setOfficialParameters({ carrier: 4, octave: 3, tone: 50, attack: 0, mod_sens: 50, release: 100 }); oscVoc.noteOn(1, 127, 127, 0);
      const oscBot = new BrowserOscBotCore(sampleRate); oscBot.setOfficialParameters({ osc: 4, note: 127, tone: 50, attack: 0, mod_sens: 50 });
      for (const core of [electric, vocoder, oscVoc, oscBot]) {
        let max = 0;
        for (let i = 0; i < 2000; i++) { const value = 8 * Math.sin(2 * Math.PI * 220 * i / sampleRate); core.processSample(value, value); max = Math.max(max, Math.abs(core.outputLeft)); }
        expect(Number.isFinite(max)).toBe(true); expect(max).toBeLessThanOrEqual(4);
      }
    }
  });
  it('remains finite at hostile input and resets deterministically', () => {
    for (const effect of Object.keys(factories) as (keyof typeof factories)[]) {
      const core = factories[effect](); core.setOfficialParameters(defaults[effect]);
      for (let i = 0; i < 1000; i++) { core.processSample(i % 2 ? Infinity : NaN, -Infinity); expect(Number.isFinite(core.outputLeft)).toBe(true); }
      core.reset();
      if (core instanceof BrowserOscVocCore) core.noteOn(1, 57, 127, 0);
      const reference = factories[effect](); reference.setOfficialParameters(defaults[effect]);
      expect(render(core, 6000)).toEqual(render(reference, 6000));
    }
  });
});
