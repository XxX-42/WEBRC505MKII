import { describe, expect, it } from 'vitest';
import { BrowserHrmAutoDsp } from '../../src/audio/fx/dsp/BrowserHrmAutoDsp';

function runTone(
  dsp: BrowserHrmAutoDsp,
  frequency: number,
  startFrame: number,
  frames: number,
  chunkSizes: readonly number[] = [frames],
): void {
  let done = 0;
  let chunk = 0;
  while (done < frames) {
    const size = Math.min(chunkSizes[chunk % chunkSizes.length]!, frames - done);
    for (let i = 0; i < size; i += 1) {
      const frame = startFrame + done;
      dsp.processSample(0.25 * Math.sin((2 * Math.PI * frequency * frame) / dsp.sampleRate), frame);
      done += 1;
    }
    chunk += 1;
  }
}

function popAll(dsp: BrowserHrmAutoDsp): Array<{
  frame: number;
  reason: number;
  note: number;
  noteOn: boolean;
  active: number;
  voices: number;
  target1: number;
  target2: number;
}> {
  const records: Array<{
    frame: number;
    reason: number;
    note: number;
    noteOn: boolean;
    active: number;
    voices: number;
    target1: number;
    target2: number;
  }> = [];
  while (dsp.tryPopStateChange()) {
    records.push({
      frame: dsp.lastStateChangeFrame,
      reason: dsp.lastStateChangeReason,
      note: dsp.lastStateChangeNote,
      noteOn: dsp.lastStateChangeNoteOn,
      active: dsp.lastStateChangeActiveCount,
      voices: dsp.lastStateChangeVoiceCount,
      target1: dsp.lastStateChangeTarget1,
      target2: dsp.lastStateChangeTarget2,
    });
  }
  return records;
}

describe('Browser HRM AUTO provisional DSP core', () => {
  it('tracks a clean monophonic source and reports bounded acquisition latency', () => {
    const dsp = new BrowserHrmAutoDsp(48_000);
    runTone(dsp, 220, 0, 12_000, [64, 127, 13, 512]);

    expect(dsp.hasPitch).toBe(true);
    expect(dsp.pitchEstimateHz).toBeCloseTo(220, 0);
    expect(dsp.pitchEstimateMidi).toBeCloseTo(57, 0);
    expect(dsp.pitchConfidence).toBeGreaterThan(0.62);
    expect(dsp.latencyFrames).toBeLessThan(3_000);
    expect(dsp.targetVoiceCount).toBe(0);
    expect(dsp.targetSemitones1).toBe(-128);
  });

  it('keeps silence and no-MIDI state dry with no active harmony targets', () => {
    const silent = new BrowserHrmAutoDsp(48_000);
    runTone(silent, 0, 0, 6_000);
    expect(silent.hasPitch).toBe(false);
    expect(silent.targetVoiceCount).toBe(0);
    expect(silent.activeMidiNoteCount).toBe(0);
    expect(silent.stateQueueDepth).toBe(0);

    const noMidi = new BrowserHrmAutoDsp(48_000);
    runTone(noMidi, 261.6256, 0, 8_000);
    expect(noMidi.hasPitch).toBe(true);
    expect(noMidi.activeMidiNoteCount).toBe(0);
    expect(noMidi.targetVoiceCount).toBe(0);
    expect(noMidi.targetSemitones1).toBe(-128);
    expect(noMidi.stateQueueDepth).toBe(0);
  });

  it('filters MIDI by configured channel and honors the absolute event frame', () => {
    const dsp = new BrowserHrmAutoDsp(48_000, { midiChannel: 2 });
    expect(dsp.enqueueMidiEvent('noteOn', 1, 60, 100, 12)).toBe(true);
    expect(dsp.enqueueMidiEvent('noteOn', 2, 67, 100, 24)).toBe(true);
    for (let frame = 0; frame < 24; frame += 1) dsp.processSample(0, frame);
    expect(dsp.activeMidiNoteCount).toBe(0);
    dsp.processSample(0, 24);
    expect(dsp.activeMidiNoteCount).toBe(1);
    expect(dsp.getActiveMidiNote(0)).toBe(67);
    const records = popAll(dsp);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ frame: 24, reason: 1, note: 67, noteOn: true, active: 1 });
  });

  it('assigns two overlapping chord notes by ascending pitch, independent of arrival order', () => {
    const dsp = new BrowserHrmAutoDsp(48_000, { key: 0, scale: 0, voices: 2 });
    runTone(dsp, 261.6256, 0, 8_000);
    expect(dsp.enqueueMidiEvent('noteOn', 1, 67, 100, 8_000)).toBe(true);
    expect(dsp.enqueueMidiEvent('noteOn', 1, 64, 100, 8_000)).toBe(true);
    dsp.processSample(0, 8_000);

    expect(dsp.activeMidiNoteCount).toBe(2);
    expect(dsp.getActiveMidiNote(0)).toBe(64);
    expect(dsp.getActiveMidiNote(1)).toBe(67);
    expect(dsp.targetVoiceCount).toBe(2);
    expect(dsp.targetSemitones1).toBeCloseTo(4, 0);
    expect(dsp.targetSemitones2).toBeCloseTo(-5, 0);
  });

  it('selects a scale third and fifth above one MIDI root, including Dorian', () => {
    const major = new BrowserHrmAutoDsp(48_000, { key: 0, scale: 0 });
    runTone(major, 220, 0, 8_000);
    major.enqueueMidiEvent('noteOn', 1, 60, 100, 8_000);
    major.processSample(0, 8_000);
    expect(major.targetVoiceCount).toBe(2);
    expect(major.targetSemitones1).toBeCloseTo(-5, 0); // nearest E octave to A3
    expect(major.targetSemitones2).toBeCloseTo(-2, 0); // nearest G octave to A3

    const dorian = new BrowserHrmAutoDsp(48_000, { key: 0, scale: 3 });
    runTone(dorian, 220, 0, 8_000);
    dorian.enqueueMidiEvent('noteOn', 1, 62, 100, 8_000);
    dorian.processSample(0, 8_000);
    expect(dorian.targetSemitones1).toBeCloseTo(-4, 0); // nearest F octave to A3
    expect(dorian.targetSemitones2).toBeCloseTo(0, 0); // A3 is the nearest A pitch
  });

  it('handles note-off, repeated-note retrigger counts, and subsequent reactivation', () => {
    const dsp = new BrowserHrmAutoDsp(48_000);
    runTone(dsp, 220, 0, 8_000);
    dsp.enqueueMidiEvent('noteOn', 1, 60, 100, 8_000);
    dsp.enqueueMidiEvent('noteOn', 1, 60, 90, 8_001);
    dsp.enqueueMidiEvent('noteOff', 1, 60, 0, 8_002);
    dsp.processSample(0, 8_000);
    dsp.processSample(0, 8_001);
    expect(dsp.activeMidiNoteCount).toBe(1);
    expect(dsp.getActiveMidiNote(0)).toBe(60);
    dsp.processSample(0, 8_002);
    expect(dsp.activeMidiNoteCount).toBe(1);
    dsp.enqueueMidiEvent('noteOff', 1, 60, 0, 8_003);
    dsp.processSample(0, 8_003);
    expect(dsp.activeMidiNoteCount).toBe(0);
    expect(dsp.targetVoiceCount).toBe(0);
    dsp.enqueueMidiEvent('noteOn', 1, 60, 100, 8_004);
    dsp.processSample(0, 8_004);
    expect(dsp.activeMidiNoteCount).toBe(1);
    expect(dsp.targetVoiceCount).toBe(2);

    const noteEvents = popAll(dsp);
    expect(noteEvents.map(({ reason, noteOn, active }) => [reason, noteOn, active])).toEqual([
      [1, true, 1],
      [1, true, 1],
      [2, false, 1],
      [2, false, 0],
      [1, true, 1],
    ]);
  });

  it('processes arbitrary caller chunk sizes identically and stays finite on invalid samples', () => {
    const regular = new BrowserHrmAutoDsp(48_000);
    const irregular = new BrowserHrmAutoDsp(48_000);
    runTone(regular, 329.6276, 0, 9_600, [9_600]);
    runTone(irregular, 329.6276, 0, 9_600, [64, 127, 13, 512, 1, 255]);
    expect(irregular.hasPitch).toBe(true);
    expect(irregular.pitchEstimateHz).toBeCloseTo(regular.pitchEstimateHz, 4);
    expect(Number.isFinite(irregular.pitchEstimateMidi)).toBe(true);
    expect(Number.isFinite(irregular.pitchConfidence)).toBe(true);
    irregular.processSample(Number.NaN, 9_600);
    irregular.processSample(Number.POSITIVE_INFINITY, 9_601);
    expect(Number.isFinite(irregular.pitchEstimateHz)).toBe(true);
    expect(Number.isFinite(irregular.pitchEstimateMidi)).toBe(true);
  });

  it('bounds MIDI and state queues and reports overflow without growing storage', () => {
    const dsp = new BrowserHrmAutoDsp(48_000, { eventCapacity: 2, stateCapacity: 1 });
    expect(dsp.enqueueMidiEvent('noteOn', 1, 60, 100, 0)).toBe(true);
    expect(dsp.enqueueMidiEvent('noteOn', 1, 62, 100, 1)).toBe(true);
    expect(dsp.enqueueMidiEvent('noteOn', 1, 64, 100, 2)).toBe(false);
    expect(dsp.queueDepth).toBe(2);
    expect(dsp.midiOverflowCount).toBe(1);

    dsp.processSample(0, 0);
    dsp.processSample(0, 1);
    dsp.processSample(0, 2);
    expect(dsp.activeMidiNoteCount).toBe(2);
    expect(dsp.stateQueueDepth).toBe(1);
    expect(dsp.stateOverflowCount).toBe(1);
    expect(dsp.tryPopStateChange()).toBe(true);
    expect(dsp.lastStateChangeFrame).toBe(0);
    expect(dsp.lastStateChangeNote).toBe(60);
    expect(dsp.stateQueueDepth).toBe(0);
    expect(dsp.tryPopStateChange()).toBe(false);
  });

  it('inserts out-of-order timestamped events in stable frame order', () => {
    const dsp = new BrowserHrmAutoDsp(48_000);
    dsp.enqueueMidiEvent('noteOn', 1, 72, 100, 50);
    dsp.enqueueMidiEvent('noteOn', 1, 60, 100, 20);
    for (let frame = 0; frame <= 50; frame += 1) dsp.processSample(0, frame);
    const events = popAll(dsp);
    expect(events.map((event) => [event.frame, event.note])).toEqual([[20, 60], [50, 72]]);
  });

  it('does not allocate output event objects from its sample callback and reset clears state', () => {
    const dsp = new BrowserHrmAutoDsp(48_000);
    dsp.enqueueMidiEvent('noteOn', 1, 60, 100, 0);
    for (let frame = 0; frame < 256; frame += 1) {
      dsp.processSample(0.1 * Math.sin((2 * Math.PI * 220 * frame) / 48_000), frame);
    }
    expect(dsp.framesProcessed).toBe(256);
    dsp.reset();
    expect(dsp.framesProcessed).toBe(0);
    expect(dsp.queueDepth).toBe(0);
    expect(dsp.stateQueueDepth).toBe(0);
    expect(dsp.activeMidiNoteCount).toBe(0);
    expect(dsp.hasPitch).toBe(false);
  });
});
