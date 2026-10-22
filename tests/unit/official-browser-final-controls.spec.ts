import { describe, expect, it } from 'vitest';
import { BrowserFxDspCore, type BrowserFxAlgorithm } from '../../src/audio/fx/dsp/BrowserFxDspCore';
import { BrowserOfficialPatternSlicerDsp } from '../../src/audio/fx/dsp/BrowserOfficialPatternSlicerDsp';
import { BrowserBeatScatterDsp } from '../../src/audio/fx/dsp/BrowserBeatScatterDsp';
import { BrowserOfficialDelayDsp } from '../../src/audio/fx/dsp/BrowserOfficialDelayDsp';
import { OfficialBrowserControlState, officialRateHz } from '../../src/audio/fx/dsp/OfficialBrowserParameters';
const rate = 8000;
function render(algorithm: BrowserFxAlgorithm, values: Record<string, number>, blocks = [10000]) {
  const dsp = new BrowserFxDspCore(algorithm, rate, values);
  const input = Float32Array.from({ length: 10000 }, (_, i) => .25 * Math.sin(i * .147) + .1 * Math.sin(i * .349));
  const left = new Float32Array(input.length), right = new Float32Array(input.length);
  for (let offset = 0, k = 0; offset < input.length; k++) {
    const end = Math.min(input.length, offset + blocks[k % blocks.length]!);
    dsp.processBlock(input.subarray(offset,end), input.subarray(offset,end), left.subarray(offset,end), right.subarray(offset,end)); offset = end;
  }
  return { input, left, right };
}
describe('Final manual Browser controls: observable semantics and boundaries', () => {
  it.each(['beat-repeat','beat-scatter'] as const)('%s THRU is exact direct PCM, not a tiny slice', algorithm => {
    const { input, left, right } = render(algorithm, { official_length: -1000 }); expect(left).toEqual(input); expect(right).toEqual(input);
  });
  it.each(['beat-repeat','beat-scatter','pattern-slicer','reverse-reverb'] as const)('%s official rendering remains sample-clocked across block sizes', algorithm => {
    const parameters = algorithm === 'pattern-slicer' ? { official_rate: 80, official_duty: 35, official_attack: 80 }
      : algorithm === 'reverse-reverb' ? { official_time: .2, official_pre_delay: 0, official_gate_time: .1, official_d_level: 0 }
      : { official_length: -.25, bpm: 300 };
    const a = render(algorithm, parameters), b = render(algorithm, parameters, [1,17,128,31,257]); expect(b.left).toEqual(a.left); expect(b.right).toEqual(a.right);
  });
  it('SCATTER honors 32nd note exactly without changing the legacy nearest-quarter division', () => {
    const official = new BrowserBeatScatterDsp(rate, { bpm: 120, sliceBeats: .125 });
    const legacy = new BrowserBeatScatterDsp(rate, { bpm: 120, sliceBeats: .125 });
    official.setOfficialLengthBeats(.125, true);
    for (let i=0;i<500;i++) { official.processSample(.1,.1); legacy.processSample(.1,.1); }
    expect(official.boundaryCount).toBe(1); expect(legacy.boundaryCount).toBe(0);
  });
  it('rejects proprietary ROM pattern names instead of aliasing invented tables', () => {
    expect(() => new BrowserFxDspCore('pattern-slicer', rate, { official_pattern: 0 })).toThrow(/Unsupported official/);
    expect(() => new BrowserFxDspCore('beat-scatter', rate, { official_type: 0 })).toThrow(/Unsupported official/);
  });
  it('reverse reverb D/E gains are independent with genuine dry-only and silence states', () => {
    const silent = render('reverse-reverb', { official_d_level: 0, official_e_level: 0 }); expect(silent.left.every(v => v === 0)).toBe(true);
    const dry = render('reverse-reverb', { official_d_level: 100, official_e_level: 0 }); expect(dry.left).toEqual(dry.input);
  });
  it('Pattern ATTACK adds onset volume, while DUTY independently changes the audible window', () => {
    const generate = (attack: number, duty: number) => {
      const p = new BrowserOfficialPatternSlicerDsp(rate, { rateHz: 10, attack, duty, compThreshold: 0, compGain: 0 });
      return Array.from({length:800}, () => { p.processSample(.1,-.05); expect(p.wetRight).toBeCloseTo(-.5*p.wetLeft,12); return p.wetLeft; });
    };
    const neutral = generate(0,50), accent = generate(100,50), short = generate(0,10);
    expect(accent[50]!).toBeGreaterThan(neutral[50]! * 2); expect(short[300]!).toBeLessThan(neutral[300]!*.01);
    expect(accent[650]!).toBeLessThan(.000001);
  });
  it('Pattern DEPTH0 retains the compressor; software pattern edits never pretend to select P01', () => {
    const p = new BrowserOfficialPatternSlicerDsp(rate, { depth:0, compThreshold:-30, compGain:0 });
    for(let i=0;i<rate;i++)p.processSample(.5,.5); expect(p.wetLeft).toBeLessThan(.1);
    const x = new BrowserOfficialPatternSlicerDsp(rate, { rateHz: 8, depth:100, attack:0, compThreshold:0, compGain:0 });
    for(let i=0;i<1200;i++)x.processSample(.1,.1); expect(x.wetLeft).toBeLessThan(.00001);
    x.setParameters({softwarePattern:1}); for(let i=0;i<100;i++)x.processSample(.1,.1); expect(x.wetLeft).toBeGreaterThan(.09);
  });
  it.each([8000,44100,48000,96000])('Pattern remains finite and resets deterministically at %s Hz', sampleRate => {
    const p = new BrowserOfficialPatternSlicerDsp(sampleRate, { rateHz:160, attack:100, duty:1, compThreshold:-30, compGain:20 });
    const first:number[]=[];for(let i=0;i<2000;i++) { p.processSample(.5,-.5); expect(Number.isFinite(p.wetLeft)).toBe(true); expect(Math.abs(p.wetLeft)).toBeLessThanOrEqual(8); first.push(p.wetLeft); }
    p.reset(); for(let i=0;i<2000;i++){p.processSample(.5,-.5);expect(p.wetLeft).toBe(first[i]);}
  });
  it.each([[30,40],[0,40],[999,300],[NaN,120]])('official BPM%s clamps safely to%s without mutating legacy updates', (input, expected) => {
    expect(officialRateHz(-1,input)).toBeCloseTo(expected/60);
    const state = new OfficialBrowserControlState('tremolo',rate); const legacy={bpm:input,mix:.2}; expect(state.translate(legacy)).toBe(legacy);
    state.translate({official_rate:-1}); expect(state.bpm).toBe(expected);
    const delay = new BrowserOfficialDelayDsp('delay',rate,{time:-2,bpm:input,feedback:16});
    expect(delay.bufferCapacitySamples).toBeLessThanOrEqual(17*3*rate+4);
  });
  it('half-note sync has a hard51-second ring ceiling, even through extreme or nonfinite tempo updates', () => {
    const delay = new BrowserOfficialDelayDsp('delay',rate,{time:-2,bpm:40,feedback:16});
    for(const bpm of [0,1,30,40,300,999,NaN,Infinity]) { delay.setParameters({bpm}); expect(delay.bufferCapacitySamples).toBe(17*3*rate+4); }
  });
});
