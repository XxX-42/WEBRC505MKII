import { describe, expect, it } from 'vitest';
import { BrowserRobotDsp } from '../../src/audio/fx/dsp/BrowserRobotDsp';

function midiToHz(midi: number): number { return 440 * (2 ** ((midi - 69) / 12)); }

function feedTone(
  dsp: BrowserRobotDsp,
  frequency: number,
  startFrame: number,
  frames: number,
  chunks: readonly number[] = [frames],
  phaseState?: { phase: number },
): void {
  let phase = phaseState?.phase ?? 0;
  const phaseIncrement = (2 * Math.PI * frequency) / dsp.sampleRate;
  let processed = 0;
  let chunkIndex = 0;
  while (processed < frames) {
    const chunkSize = Math.min(Math.max(1, chunks[chunkIndex % chunks.length] ?? frames), frames - processed);
    for (let offset = 0; offset < chunkSize; offset += 1) {
      const frame = startFrame + processed;
      const sample = 0.3 * Math.sin(phase);
      dsp.processSample(sample, frame);
      phase += phaseIncrement;
      processed += 1;
    }
    chunkIndex += 1;
  }
  if (phaseState) phaseState.phase = phase % (2 * Math.PI);
}

function feedSilence(dsp: BrowserRobotDsp, startFrame: number, frames: number): void {
  for (let offset = 0; offset < frames; offset += 1) dsp.processSample(0, startFrame + offset);
}

interface TargetEvent {
  frame: number;
  semitones: number;
  sourceMidi: number;
  targetMidi: number;
  sourceHz: number;
  confidence: number;
  voiced: boolean;
}

function drain(dsp: BrowserRobotDsp): TargetEvent[] {
  const events: TargetEvent[] = [];
  while (dsp.tryPopTargetChange()) {
    events.push({
      frame: dsp.lastTargetFrame,
      semitones: dsp.lastTargetSemitones,
      sourceMidi: dsp.lastTargetSourceMidi,
      targetMidi: dsp.lastTargetMidi,
      sourceHz: dsp.lastTargetHz,
      confidence: dsp.lastTargetConfidence,
      voiced: dsp.lastTargetVoiced,
    });
  }
  return events;
}

describe('Browser ROBOT provisional DSP controller', () => {
  it('tracks a monophonic source and computes a quantized target including the pitch control', () => {
    const dsp = new BrowserRobotDsp(48_000, { pitch: 4.2 });
    feedTone(dsp, 220, 0, 12_000, [64, 127, 13, 512]);
    const events = drain(dsp);

    expect(dsp.hasPitch).toBe(true);
    expect(dsp.pitchEstimateHz).toBeCloseTo(220, 0);
    expect(dsp.pitchEstimateMidi).toBeCloseTo(57, 0);
    expect(dsp.targetMidi).toBe(61);
    expect(dsp.targetSemitones).toBeCloseTo(61 - dsp.pitchEstimateMidi, 2);
    expect(events.some((event) => event.voiced && event.targetMidi === 61)).toBe(true);
    expect(events.every((event) => Number.isSafeInteger(event.frame) && Number.isFinite(event.semitones))).toBe(true);
    expect(dsp.latencyFrames).toBeLessThan(4_800);
    expect(dsp.processingMode).toBe('psola');
    expect(dsp.modeReason).toBe('stable-voiced');
    expect(dsp.psolaLatencySamples).toBeGreaterThan(0);
    expect(dsp.psolaLatencySamples / dsp.sampleRate).toBeLessThan(0.03);
  });

  it('keeps low notes, wide shifts, and independent formant requests on Signalsmith', () => {
    const low = new BrowserRobotDsp(48_000);
    feedTone(low, 110, 0, 12_000);
    expect(low.processingMode).toBe('signalsmith');
    expect(low.modeReason).toBe('source-frequency-out-of-range');

    const wide = new BrowserRobotDsp(48_000, { pitch: 18 });
    feedTone(wide, 220, 0, 12_000);
    expect(wide.processingMode).toBe('signalsmith');
    expect(wide.modeReason).toBe('target-shift-out-of-range');

    const formant = new BrowserRobotDsp(48_000);
    feedTone(formant, 220, 0, 12_000);
    expect(formant.processingMode).toBe('psola');
    formant.setParameters({ formant: 3 });
    expect(formant.processingMode).toBe('signalsmith');
    expect(formant.modeReason).toBe('formant-control-active');
  });

  it('does not enter PSOLA on a clean inharmonic two-tone mixture', () => {
    const dsp = new BrowserRobotDsp(48_000);
    let phaseA = 0;
    let phaseB = 0;
    for (let frame = 0; frame < 24_000; frame += 1) {
      const sample = 0.22 * Math.sin(phaseA) + 0.22 * Math.sin(phaseB);
      dsp.processSample(sample, frame);
      phaseA += (2 * Math.PI * 220) / 48_000;
      phaseB += (2 * Math.PI * 317) / 48_000;
    }
    expect(dsp.processingMode).toBe('signalsmith');
    expect(['low-confidence', 'unstable-f0', 'source-frequency-out-of-range']).toContain(dsp.modeReason);
  });

  it('holds a note through half-semitone jitter and switches only after the 0.05-semitone hysteresis margin', () => {
    const dsp = new BrowserRobotDsp(48_000);
    const sweep = [60.40, 60.48, 60.52, 60.49, 60.53, 60.50, 60.54, 60.52, 60.56, 60.53, 60.50, 60.48, 60.46, 60.44];
    const observed: number[] = [];
    const phase = { phase: 0 };
    let frame = 0;
    for (const midi of sweep) {
      feedTone(dsp, midiToHz(midi), frame, 8_192, [8_192], phase);
      frame += 8_192;
      observed.push(dsp.targetMidi);
      drain(dsp);
    }

    expect(observed.slice(0, 8).every((note) => note === 60)).toBe(true);
    expect(observed[8]).toBe(61);
    expect(observed.slice(8, -1).every((note) => note === 61)).toBe(true);
    expect(observed.at(-1)).toBe(60);
  });

  it('keeps continuous source correction within a selected note and is invariant to chunk sizes', () => {
    const whole = new BrowserRobotDsp(48_000);
    const split = new BrowserRobotDsp(48_000);
    feedTone(whole, 220, 0, 8_192);
    feedTone(split, 220, 0, 8_192, [1, 17, 127, 3, 512]);
    feedTone(whole, 225, 8_192, 8_192);
    feedTone(split, 225, 8_192, 8_192, [31, 64, 257, 7]);

    expect(whole.targetMidi).toBe(57);
    expect(whole.targetSemitones).toBeLessThan(-0.2);
    expect(whole.targetSemitones).toBeGreaterThan(-0.6);
    expect(split.targetMidi).toBe(whole.targetMidi);
    expect(split.pitchEstimateMidi).toBeCloseTo(whole.pitchEstimateMidi, 5);
    expect(drain(split)).toEqual(drain(whole));
  });

  it('emits one unvoiced transition after silence, bounds queues, and resets cleanly', () => {
    const silent = new BrowserRobotDsp(48_000);
    feedSilence(silent, 0, 16_000);
    expect(silent.hasPitch).toBe(false);
    expect(silent.queueDepth).toBe(0);
    expect(silent.processingMode).toBe('signalsmith');
    expect(silent.modeReason).toBe('unvoiced');

    const dsp = new BrowserRobotDsp(48_000);
    feedTone(dsp, 220, 0, 8_192);
    expect(drain(dsp).some((event) => event.voiced)).toBe(true);
    feedSilence(dsp, 8_192, 16_000);
    const release = drain(dsp);
    expect(release.filter((event) => !event.voiced)).toHaveLength(1);
    feedSilence(dsp, 24_192, 16_000);
    expect(drain(dsp)).toHaveLength(0);

    const crowded = new BrowserRobotDsp(48_000);
    feedTone(crowded, 220, 0, 8_192);
    for (let index = 0; index < 50; index += 1) {
      const frame = 8_192 + index;
      crowded.processSample(0, frame);
      crowded.setParameters({ pitch: -24 + ((index * 11) % 49) });
    }
    expect(crowded.queueDepth).toBeLessThanOrEqual(32);
    expect(crowded.queueOverflowCount).toBeGreaterThan(0);
    for (const event of drain(crowded)) {
      expect(Number.isFinite(event.frame)).toBe(true);
      expect(Number.isFinite(event.semitones)).toBe(true);
      expect(Number.isFinite(event.sourceMidi)).toBe(true);
      expect(Number.isFinite(event.sourceHz)).toBe(true);
      expect(event.confidence).toBeGreaterThanOrEqual(0);
      expect(event.confidence).toBeLessThanOrEqual(1);
    }

    dsp.reset();
    expect(dsp.hasPitch).toBe(false);
    expect(dsp.queueDepth).toBe(0);
    feedTone(dsp, 220, 0, 8_192);
    expect(dsp.hasPitch).toBe(true);
  });
});
