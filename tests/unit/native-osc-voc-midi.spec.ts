import { describe, expect, it } from 'vitest';
import {
  mapMidiNoteToNativeCatalogEvent,
  mapMidiNoteToNativeOscVocEvent,
} from '../../src/audio/nativeOscVocMidi';

describe('Native OSC VOC Web MIDI frame mapping', () => {
  const target = { path: 'track' as const, slot: 'C' as const };
  const anchor = {
    sampleFrame: 48_000,
    observedAtPerformanceTimeMs: 5_000,
    sampleRate: 48_000,
    suggestedLeadFrames: 960,
  };

  it('maps future note-on timestamps to the chosen Native slot and absolute frame', () => {
    expect(mapMidiNoteToNativeOscVocEvent({
      channel: 4,
      note: 69,
      velocity: 0.5,
      noteOn: true,
      timeStampMs: 5_012.25,
    }, target, anchor)).toEqual({
      path: 'track',
      slot: 'C',
      type: 'noteOn',
      channel: 4,
      note: 69,
      velocity: 64,
      frame: 48_000 + 588 + 960,
    });
  });

  it('maps note-off and clamps timestamps preceding the latest frame anchor', () => {
    expect(mapMidiNoteToNativeOscVocEvent({
      channel: 1,
      note: 60,
      velocity: 0,
      noteOn: false,
      timeStampMs: 4_900,
    }, { path: 'input', slot: 'A' }, anchor)).toEqual({
      path: 'input',
      slot: 'A',
      type: 'noteOff',
      channel: 1,
      note: 60,
      velocity: 0,
      frame: 48_960,
    });
  });

  it('rejects unsafe or invalid sample-clock anchors', () => {
    const event = { channel: 1, note: 64, velocity: 1, noteOn: true, timeStampMs: 5_000 };
    expect(() => mapMidiNoteToNativeOscVocEvent(event, target, { ...anchor, sampleFrame: Number.MAX_SAFE_INTEGER })).toThrow(/safe integer/);
    expect(() => mapMidiNoteToNativeOscVocEvent(event, target, { ...anchor, sampleRate: 44_100.5 })).toThrow(/invalid/);
  });

  it('preserves the explicitly selected catalog MIDI effect in the scheduled event', () => {
    const event = {
      channel: 3,
      note: 65,
      velocity: 1,
      noteOn: true,
      timeStampMs: 5_000,
    };
    expect(mapMidiNoteToNativeCatalogEvent(event, {
      path: 'input', slot: 'D', effectId: 'hrm_auto_m',
    }, anchor)).toEqual({
      effectId: 'hrm_auto_m',
      path: 'input',
      slot: 'D',
      type: 'noteOn',
      channel: 3,
      note: 65,
      velocity: 127,
      frame: anchor.sampleFrame + anchor.suggestedLeadFrames,
    });
    expect(mapMidiNoteToNativeCatalogEvent(event, target, anchor).effectId).toBe('osc_voc_m');
  });
});
