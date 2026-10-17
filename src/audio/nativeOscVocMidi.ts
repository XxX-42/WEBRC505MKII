import type { MidiNoteEvent } from './MidiInputController';
import type { NativeOscVocMidiEvent, NativeFxSlot } from './NativeBridgeClient';
import type { NativeFxPath } from './nativeFxCatalog';

export interface OscVocMidiTarget {
  path: NativeFxPath;
  slot: NativeFxSlot;
  /** Omitted by legacy callers; the Browser/Native adapter defaults to OSC VOC. */
  effectId?: 'osc_voc_m' | 'hrm_auto_m';
}

export interface NativeMidiFrameAnchor {
  sampleFrame: number;
  observedAtPerformanceTimeMs: number;
  sampleRate: number;
  suggestedLeadFrames: number;
}

/** Convert a Web MIDI timestamp to the Native engine's absolute sample clock. */
export function mapMidiNoteToNativeOscVocEvent(
  event: MidiNoteEvent,
  target: OscVocMidiTarget,
  anchor: NativeMidiFrameAnchor,
): NativeOscVocMidiEvent {
  if (!Number.isSafeInteger(anchor.sampleFrame) || anchor.sampleFrame < 0 ||
      !Number.isFinite(anchor.observedAtPerformanceTimeMs) ||
      !Number.isInteger(anchor.sampleRate) || anchor.sampleRate <= 0 ||
      !Number.isSafeInteger(anchor.suggestedLeadFrames) || anchor.suggestedLeadFrames < 0 ||
      !Number.isFinite(event.timeStampMs)) {
    throw new RangeError('Native OSC VOC MIDI frame anchor or timestamp is invalid.');
  }

  const timestampOffsetFrames = Math.max(
    0,
    Math.ceil((event.timeStampMs - anchor.observedAtPerformanceTimeMs) * anchor.sampleRate / 1000),
  );
  const frame = anchor.sampleFrame + timestampOffsetFrames + anchor.suggestedLeadFrames;
  if (!Number.isSafeInteger(frame)) throw new RangeError('Native OSC VOC MIDI frame exceeds the safe integer range.');

  return {
    path: target.path,
    slot: target.slot,
    type: event.noteOn ? 'noteOn' : 'noteOff',
    channel: event.channel,
    note: event.note,
    velocity: Math.round(event.velocity * 127),
    frame,
  };
}

/** Convert a Web MIDI event for an explicitly selected MIDI-driven catalog FX. */
export function mapMidiNoteToNativeCatalogEvent(
  event: MidiNoteEvent,
  target: OscVocMidiTarget,
  anchor: NativeMidiFrameAnchor,
): NativeOscVocMidiEvent & { effectId: 'osc_voc_m' | 'hrm_auto_m' } {
  const eventBase = mapMidiNoteToNativeOscVocEvent(event, target, anchor);
  return { ...eventBase, effectId: target.effectId ?? 'osc_voc_m' };
}
