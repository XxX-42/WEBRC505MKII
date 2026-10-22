import { describe, expect, it } from 'vitest';
import { BrowserOscVocCore } from '../../src/audio/fx/BrowserOscVocCore';

function deterministicNoise(frames: number, seed = 0x13579bdf): Float32Array {
  const output = new Float32Array(frames);
  let state = seed >>> 0;
  for (let frame = 0; frame < frames; frame += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    output[frame] = (((state >>> 8) / 0x800000) - 1) * 0.35;
  }
  return output;
}

/** Independent Goertzel spectral magnitude oracle. */
function goertzelMagnitude(
  samples: Float32Array,
  sampleRate: number,
  frequencyHz: number,
  start: number,
  count: number,
): number {
  const coefficient = 2 * Math.cos((2 * Math.PI * frequencyHz) / sampleRate);
  let previous = 0;
  let previous2 = 0;
  for (let frame = start; frame < start + count; frame += 1) {
    const current = (samples[frame] ?? 0) + (coefficient * previous) - previous2;
    previous2 = previous;
    previous = current;
  }
  const power = Math.max(0, (previous * previous) + (previous2 * previous2) - (coefficient * previous * previous2));
  return (2 * Math.sqrt(power)) / Math.max(1, count);
}

function rms(samples: Float32Array, start: number, end: number): number {
  let sum = 0;
  const count = Math.max(1, end - start);
  for (let index = start; index < end; index += 1) {
    const value = samples[index] ?? 0;
    sum += value * value;
  }
  return Math.sqrt(sum / count);
}

function renderSamples(core: BrowserOscVocCore, input: Float32Array): Float32Array {
  const output = new Float32Array(input.length);
  for (let frame = 0; frame < input.length; frame += 1) {
    core.processSample(input[frame] ?? 0);
    output[frame] = core.outputLeft;
  }
  return output;
}

function renderBlocks(
  core: BrowserOscVocCore,
  input: Float32Array,
  blockSizes: readonly number[],
): Float32Array {
  const output = new Float32Array(input.length);
  const right = new Float32Array(input.length);
  let offset = 0;
  let blockIndex = 0;
  while (offset < input.length) {
    const requested = blockSizes[blockIndex % blockSizes.length] ?? input.length;
    const frames = Math.min(Math.max(1, requested), input.length - offset);
    const blockOutLeft = new Float32Array(frames);
    const blockOutRight = new Float32Array(frames);
    core.processBlock(input.subarray(offset, offset + frames), right.subarray(offset, offset + frames), blockOutLeft, blockOutRight, frames);
    output.set(blockOutLeft, offset);
    offset += frames;
    blockIndex += 1;
  }
  return output;
}

describe('Browser OSC VOC (M) sample-frame core', () => {
  it('schedules a frame-aligned all-notes-off even when the bounded queue is full', () => {
    const core = new BrowserOscVocCore(48_000);
    core.noteOn(1, 60, 100, 0);
    core.processSample(0);
    expect(core.activeNote).toBe(60);
    for (let index = 0; index < core.eventCapacity; index += 1) {
      core.noteOn(1, index % 128, 100, core.currentFrame + 10 + index);
    }
    expect(core.pendingEventCount).toBe(core.eventCapacity);
    const releaseFrame = core.currentFrame + 20;
    core.allNotesOff(releaseFrame);
    expect(core.pendingEventCount).toBe(1);
    const left = new Float32Array(32);
    const right = new Float32Array(32);
    core.processBlock(new Float32Array(32), new Float32Array(32), left, right, 32);
    expect(core.activeNote).toBeNull();
    expect(core.currentFrame).toBe(releaseFrame + 12);
    expect(core.pendingEventCount).toBe(0);
  });

  it('tracks MIDI pitch with the independent spectral oracle and applies octave transpose', () => {
    const sampleRate = 48_000;
    const input = deterministicNoise(sampleRate);
    const renderPitch = (note: number): Float32Array => {
      const core = new BrowserOscVocCore(sampleRate, { waveform: 0 });
      core.noteOn(1, note, 127, 0);
      const output = renderSamples(core, input);
      expect(core.latencySamples).toBe(0);
      return output;
    };
    const a4 = renderPitch(69);
    const a5 = renderPitch(81);
    const analysisStart = 12_000;
    const analysisCount = 24_000;
    const a4Fundamental = goertzelMagnitude(a4, sampleRate, 440, analysisStart, analysisCount);
    const a4Octave = goertzelMagnitude(a4, sampleRate, 880, analysisStart, analysisCount);
    const a5Fundamental = goertzelMagnitude(a5, sampleRate, 880, analysisStart, analysisCount);
    const a5Subharmonic = goertzelMagnitude(a5, sampleRate, 440, analysisStart, analysisCount);

    expect(a4Fundamental).toBeGreaterThan(a4Octave * 1.15);
    expect(a5Fundamental).toBeGreaterThan(a5Subharmonic * 1.15);
    expect(a4Fundamental).toBeGreaterThan(0.002);
    expect(a5Fundamental).toBeGreaterThan(0.002);

    const transposed = new BrowserOscVocCore(sampleRate);
    transposed.noteOn(1, 69, 100, 0);
    transposed.setParameters({ octave: 12 });
    transposed.processSample(0.2);
    expect(transposed.targetFrequencyHz).toBeCloseTo(880, 8);
    expect(transposed.activeNote).toBe(69);
  });

  it('renders distinct band-limited saw, square, and pulse carriers', () => {
    const sampleRate = 48_000;
    const input = deterministicNoise(24_000, 12345);
    const outputs = ([0, 1, 2] as const).map((waveform) => {
      const core = new BrowserOscVocCore(sampleRate, { waveform });
      core.noteOn(1, 60, 127, 0);
      return renderSamples(core, input);
    });

    expect(outputs[0]).not.toEqual(outputs[1]);
    expect(outputs[1]).not.toEqual(outputs[2]);
    expect(outputs[0]).not.toEqual(outputs[2]);
    const fundamentalSaw = goertzelMagnitude(outputs[0]!, sampleRate, 261.625565, 6000, 12_000);
    const fundamentalSquare = goertzelMagnitude(outputs[1]!, sampleRate, 261.625565, 6000, 12_000);
    const fundamentalPulse = goertzelMagnitude(outputs[2]!, sampleRate, 261.625565, 6000, 12_000);
    expect(fundamentalSaw).toBeGreaterThan(0.001);
    expect(fundamentalSquare).toBeGreaterThan(0.001);
    expect(fundamentalPulse).toBeGreaterThan(0.001);
    expect(Math.max(fundamentalSaw, fundamentalSquare, fundamentalPulse)
      - Math.min(fundamentalSaw, fundamentalSquare, fundamentalPulse)).toBeGreaterThan(0.00005);
  });

  it('applies note-off at the exact frame and fades to silence', () => {
    const sampleRate = 48_000;
    const frames = 28_000;
    const input = deterministicNoise(frames, 0x2468ace0);
    const core = new BrowserOscVocCore(sampleRate, { waveform: 1 });
    core.noteOn(1, 69, 127, 0);
    core.noteOff(1, 69, 8000);
    const output = renderSamples(core, input);

    expect(rms(output, 4000, 7900)).toBeGreaterThan(0.002);
    expect(rms(output, 20_000, 27_999)).toBeLessThan(0.0001);
    expect(core.activeNote).toBeNull();
    expect(core.pendingEventCount).toBe(0);
  });

  it('keeps absolute-frame MIDI events invariant across variable blocks and same-frame ordering', () => {
    const frames = 10_003;
    const input = deterministicNoise(frames, 0x10203040);
    const schedule = (core: BrowserOscVocCore): void => {
      core.noteOn(1, 60, 100, 17);
      core.noteOn(2, 69, 127, 128); // filtered by the selected channel
      core.noteOn(1, 72, 127, 512);
      core.noteOff(1, 72, 1024);
      core.noteOff(1, 60, 4097);
      core.noteOn(1, 67, 127, 5000);
      core.noteOff(1, 67, 9000);
      core.noteOn(1, 69, 90, 9000); // same frame: insertion order makes this the held note
    };
    const whole = new BrowserOscVocCore(48_000, { waveform: 2 });
    const variable = new BrowserOscVocCore(48_000, { waveform: 2 });
    schedule(whole);
    schedule(variable);

    const wholeOutput = renderBlocks(whole, input, [frames]);
    const variableOutput = renderBlocks(variable, input, [1, 17, 128, 257, 31, 509, 73]);

    expect(variableOutput).toEqual(wholeOutput);
    expect(whole.currentFrame).toBe(frames);
    expect(variable.currentFrame).toBe(frames);
    expect(whole.activeNote).toBe(69);
    expect(whole.pendingEventCount).toBe(0);
    expect([...wholeOutput].every(Number.isFinite)).toBe(true);
  });

  it('rejects malformed or stale MIDI events and refuses queue overflow without dropping silently', () => {
    const core = new BrowserOscVocCore(48_000);
    expect(() => core.noteOn(0, 60, 127, 0)).toThrow(/channel must be an integer from 1 to 16/);
    expect(() => core.noteOn(17, 60, 127, 0)).toThrow(/channel must be an integer from 1 to 16/);
    expect(() => core.noteOn(1, -1, 127, 0)).toThrow(/note must be an integer from 0 to 127/);
    expect(() => core.noteOff(1, 128, 0)).toThrow(/note must be an integer from 0 to 127/);
    expect(() => core.noteOn(1, 60.5, 127, 0)).toThrow(/note must be an integer from 0 to 127/);
    expect(() => core.noteOn(1, 60, -1, 0)).toThrow(/velocity must be an integer from 0 to 127/);
    expect(() => core.noteOn(1, 60, 127.5, 0)).toThrow(/velocity must be an integer from 0 to 127/);
    expect(() => core.noteOn(1, 60, 127, -1)).toThrow(/non-negative safe integer/);
    expect(() => core.noteOn(1, 60, 127, 0.5)).toThrow(/non-negative safe integer/);
    expect(() => core.noteOn(1, 60, 127, Number.MAX_SAFE_INTEGER + 1)).toThrow(/non-negative safe integer/);

    core.noteOn(1, 60, 100, 0);
    core.processSample(0.1);
    expect(() => core.noteOff(1, 60, 0)).toThrow(/at or after 1/);
    for (let event = 0; event < core.eventCapacity; event += 1) core.noteOn(1, event % 128, 100, 1000);
    expect(core.pendingEventCount).toBe(core.eventCapacity);
    expect(() => core.noteOn(1, 60, 100, 1000)).toThrow(/event queue is full/);
    expect(core.pendingEventCount).toBe(core.eventCapacity);

    expect(() => core.setParameters({ waveform: 3 })).toThrow(/waveform must be 0/);
    expect(() => core.setParameters({ midiChannel: 0 })).toThrow(/MIDI channel must be an integer from 1 to 16/);
    expect(() => core.setParameters({ octave: 25 })).toThrow(/transpose must be between -24 and 24/);
    expect(() => core.setParameters({ bands: 25 })).toThrow(/bands must be an integer from 8 to 24/);
    expect(() => core.setParameters({ formant: 0 } as never)).toThrow(/does not support the formant parameter/);
    expect(core.waveform).toBe(0);
    expect(core.midiChannel).toBe(1);
    expect(core.octave).toBe(0);
  });

  it('handles mono and stereo modulators with finite bounded centered output', () => {
    const frames = 4096;
    const input = deterministicNoise(frames, 0xdeadbeef);
    input[30] = Number.NaN;
    input[31] = Number.POSITIVE_INFINITY;
    input[32] = 1000;
    const mono = new BrowserOscVocCore(48_000);
    const stereo = new BrowserOscVocCore(48_000);
    mono.noteOn(1, 48, 127, 0);
    stereo.noteOn(1, 48, 127, 0);
    const monoLeft = new Float32Array(frames);
    const monoRight = new Float32Array(frames);
    const stereoLeft = new Float32Array(frames);
    const stereoRight = new Float32Array(frames);
    mono.processBlock(input, null, monoLeft, monoRight);
    stereo.processBlock(input, input, stereoLeft, stereoRight);

    expect(monoLeft).toEqual(stereoLeft);
    expect(monoLeft).toEqual(monoRight);
    expect(stereoLeft).toEqual(stereoRight);
    for (const sample of monoLeft) {
      expect(Number.isFinite(sample)).toBe(true);
      expect(Math.abs(sample)).toBeLessThanOrEqual(4);
    }
    expect(() => new BrowserOscVocCore(7999)).toThrow(/sample rate must be/);
    expect(() => mono.processBlock(input, null, monoLeft, monoRight, frames + 1)).toThrow(/input buffers are shorter/);
  });

  it('restores the most recent still-held note and reset clears scheduled state', () => {
    const core = new BrowserOscVocCore(48_000);
    core.noteOn(1, 60, 80, 0);
    core.noteOn(1, 64, 100, 1);
    core.noteOff(1, 64, 2);
    core.processBlock(new Float32Array(3), null, new Float32Array(3), new Float32Array(3));
    expect(core.activeNote).toBe(60);
    expect(core.targetFrequencyHz).toBeCloseTo(261.625565, 4);

    core.noteOff(1, 60, 20);
    core.reset();
    expect(core.currentFrame).toBe(0);
    expect(core.pendingEventCount).toBe(0);
    expect(core.activeNote).toBeNull();
    expect(core.outputLeft).toBe(0);
    core.noteOn(1, 69, 127, 0);
    expect(core.pendingEventCount).toBe(1);
  });

  it('aligns its absolute frame cursor with a nonzero AudioWorklet currentFrame', () => {
    const core = new BrowserOscVocCore(48_000, {}, 4096);
    expect(core.currentFrame).toBe(4096);
    core.noteOn(1, 69, 127, 4096);
    expect(() => core.synchronizeFrame(8192)).toThrow(/while MIDI events are pending/);
    core.reset(8192);
    expect(core.currentFrame).toBe(8192);
    core.synchronizeFrame(9000);
    expect(core.currentFrame).toBe(9000);
    expect(() => core.synchronizeFrame(-1)).toThrow(/non-negative safe integer/);
  });
});
