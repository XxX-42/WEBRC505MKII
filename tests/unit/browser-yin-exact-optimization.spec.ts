import { describe, expect, it } from 'vitest';
import { BrowserRobotDsp } from '../../src/audio/fx/dsp/BrowserRobotDsp';
import { LiveMonoPitchProcessor, YinPitchDetector } from '../../src/audio/pitch/liveMono';
import { BrowserRobotDsp as BeforeRobot } from '../fixtures/browser-yin-before/src/audio/fx/dsp/BrowserRobotDsp';
import { LiveMonoPitchProcessor as BeforeLive, YinPitchDetector as BeforeYin } from '../fixtures/browser-yin-before/src/audio/pitch/liveMono';

// Early termination intentionally leaves unused scratch tails different.
// Every recursive field, ring byte, queue, control, estimate and PCM stays exact.
const scratch = new Set(['differences', 'normalizedDifferences', 'yinCmnd']);
type Fields = Record<string, any>;
function compareState(before: any, after: any, path = 'state'): void {
  if (ArrayBuffer.isView(before)) {
    const a = Buffer.from(before.buffer, before.byteOffset, before.byteLength);
    const b = Buffer.from(after.buffer, after.byteOffset, after.byteLength);
    if (!a.equals(b)) throw new Error(`${path}: typed-array bytes differ`);
  } else if (before !== null && typeof before === 'object') {
    for (const key of Object.keys(before)) {
      if (!scratch.has(key)) compareState(before[key], after[key], `${path}.${key}`);
    }
  } else if (!Object.is(before, after)) {
    throw new Error(`${path}: ${String(before)} != ${String(after)}`);
  }
}
function poison(object: Fields): void {
  if (object.differences) object.differences.fill(NaN, 1, object.maximumLag + 1);
  if (object.normalizedDifferences) object.normalizedDifferences.fill(NaN, 1, object.maximumLag + 1);
  // Do not poison index 0 or maxLag+1: these are interpolation sentinels.
  if (object.yinCmnd) object.yinCmnd.fill(NaN, 1, object.maxLag + 1);
  for (const value of Object.values(object)) {
    if (value !== null && typeof value === 'object' && !ArrayBuffer.isView(value)) poison(value);
  }
}
function drain(robot: BrowserRobotDsp | BeforeRobot): unknown[] {
  const events: unknown[] = [];
  while (robot.tryPopTargetChange()) {
    events.push([robot.lastTargetFrame, robot.lastTargetSemitones, robot.lastTargetSourceMidi,
      robot.lastTargetMidi, robot.lastTargetHz, robot.lastTargetConfidence, robot.lastTargetVoiced]);
  }
  return events;
}
function exactSample(a: number, b: number, index: number): void {
  if (!Object.is(a, b)) throw new Error(`PCM differs at frame ${index}: ${a} != ${b}`);
}

// Reconstructed after workspace loss. These tests are not earlier test evidence.
describe('exact YIN frame-copy and prefix termination', () => {
  for (const rate of [12000, 22050, 44100, 48000, 88200, 96000]) {
    it(`keeps PCM and recursive state through mixed input, reset and poisoned scratch at ${rate}`, () => {
      const before = new BeforeRobot(rate, { pitch: 3.2 });
      const after = new BrowserRobotDsp(rate, { pitch: 3.2 });
      const oldLive = new BeforeLive({ sampleRate: rate, semitones: 3.2 });
      const newLive = new LiveMonoPitchProcessor({ sampleRate: rate, semitones: 3.2 });
      const input = new Float32Array(131), a = new Float32Array(131), b = new Float32Array(131);
      let random = 0x12345678;
      for (let start = 0; start < 16384; start += 127) {
        const count = Math.min(127, 16384 - start);
        if (start === 127 * 40) { before.setParameters({ formant: 2 }); after.setParameters({ formant: 2 }); }
        if (start === 127 * 80) { before.reset(); after.reset(); }
        if (start === 127 * 96) { before.setParameters({ formant: 0 }); after.setParameters({ formant: 0 }); }
        poison(after as unknown as Fields); poison(newLive as unknown as Fields);
        for (let j = 0; j < count; j += 1) {
          const i = start + j;
          random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
          const segment = Math.floor(i / 2048) % 4;
          let value = segment === 0 ? 0 : segment === 1 ? (random / 0x100000000 - 0.5) * 0.2
            : 0.3 * Math.sin(2 * Math.PI * (segment === 2 ? 147 : 440) * i / rate);
          if (i % 4093 === 0) value = i % 2 ? Infinity : NaN;
          input[j + 2] = value;
          before.processSample(value, i); after.processSample(value, i);
          exactSample(before.psolaOutputSample, after.psolaOutputSample, i);
        }
        oldLive.process(input, a, count, 2, 1); newLive.process(input, b, count, 2, 1);
        compareState(a, b, 'live PCM'); compareState(before, after); compareState(oldLive, newLive);
        expect(drain(after)).toEqual(drain(before));
      }
      expect(after.framesProcessed).toBeGreaterThan(0);
    });
  }

  for (const frequency of [98, 147, 220, 440]) {
    it(`keeps long voiced PCM and mode changes exact at ${frequency} Hz`, () => {
      const before = new BeforeRobot(48000, { pitch: 2 });
      const after = new BrowserRobotDsp(48000, { pitch: 2 });
      let psolaFrames = 0, signalsmithFrames = 0, energy = 0;
      for (let i = 0; i < 131072; i += 1) {
        if (i === 65536 || i === 98304) {
          const parameters = { formant: i === 65536 ? 2 : 0 };
          before.setParameters(parameters); after.setParameters(parameters);
        }
        if (i % 1024 === 0) poison(after as unknown as Fields);
        const sample = 0.3 * Math.sin(2 * Math.PI * frequency * i / 48000);
        before.processSample(sample, i); after.processSample(sample, i);
        exactSample(before.psolaOutputSample, after.psolaOutputSample, i);
        energy += after.psolaOutputSample ** 2;
        if (after.processingMode === 'psola') psolaFrames += 1; else signalsmithFrames += 1;
        if (i % 1024 === 1023) {
          compareState(before, after);
          expect(drain(after)).toEqual(drain(before));
        }
      }
      expect(energy).toBeGreaterThan(0); expect(signalsmithFrames).toBeGreaterThan(0);
      if (frequency >= 147) expect(psolaFrames).toBeGreaterThan(0);
    });
  }

  for (const rate of [2000, 4000, 8000, 12000, 24000, 48000]) {
    for (const threshold of [0.03, 0.4]) {
      it(`overwrites every needed detector scratch prefix at ${rate} Hz / threshold ${threshold}`, () => {
        const options = { minimumFrequencyHz: 70, maximumFrequencyHz: 1000, threshold };
        const before = new BeforeYin(rate, options), after = new YinPitchDetector(rate, options);
        let random = 0x23456789;
        for (let i = 0; i < 16384; i += 1) {
          if (i % 127 === 0) poison(after as unknown as Fields);
          random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
          const segment = Math.floor(i / 2048) % 4;
          const sample = segment === 0 ? 0 : segment === 1 ? (random / 0x100000000 - 0.5) * 0.3
            : 0.3 * Math.sin(2 * Math.PI * (segment === 2 ? 147 : 440) * i / rate);
          before.pushSample(sample); after.pushSample(sample);
          if (i % 127 === 126) compareState(before, after);
        }
        compareState(before, after); expect(after.analysisSerial).toBeGreaterThan(0);
      });
    }
  }
});
