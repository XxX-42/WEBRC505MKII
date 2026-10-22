import type { NativeCatalogSlotConfig, NativeFxSlot, NativeStatus } from './NativeBridgeClient';
import { Transport } from '../core/Transport';

export type NativeFxPath = 'input' | 'track';

export const NATIVE_FX_SLOT_IDS: readonly NativeFxSlot[] = ['A', 'B', 'C', 'D'];
export const NATIVE_CATALOG_EMPTY_LABEL = 'NONE';

/** Display labels for the Native catalog graph, sourced from current Native processors. */
export const NATIVE_CATALOG_FX_LABELS: Readonly<Record<string, string>> = {
  'filter.lpf': 'DSP LPF',
  'filter.bpf': 'DSP BPF',
  'filter.hpf': 'DSP HPF',
  phaser: 'PHASER',
  flanger: 'FLANGER',
  dynamics: 'DYNAMICS',
  dist: 'DIST',
  reverb: 'REVERB (FDN16)',
  gate_reverb: 'GATE REVERB',
  beat_repeat: 'BEAT REPEAT',
  beat_scatter: 'BEAT SCATTER',
  beat_shift: 'BEAT SHIFT',
  roll: 'ROLL',
  freeze: 'FREEZE',
  warp: 'WARP (EXPERIMENTAL)',
  tape_echo: 'TAPE ECHO',
  reverse_delay: 'REVERSE DELAY',
  reverse_reverb: 'REVERSE REVERB (EXPERIMENTAL)',
  fractional_delay: 'DELAY',
  mod_delay: 'MOD DELAY',
  panning_delay: 'PANNING DELAY',
  twist: 'TWIST',
  granular_delay: 'GRANULAR DELAY',
  auto_pan: 'AUTO PAN',
  manual_pan: 'MANUAL PAN',
  chorus: 'CHORUS',
  tremolo: 'TREMOLO',
  ring_mod: 'RING.MOD',
  eq: 'EQ',
  isolator: 'ISOLATOR',
  stereo_enhance: 'STEREO ENHANCE',
  lo_fi: 'LO-FI',
  radio: 'RADIO',
  sustainer: 'SUSTAINER',
  vibrato: 'VIBRATO',
  slow_gear: 'SLOW GEAR',
  pattern_slicer: 'PATTERN SLICER',
  step_slicer: 'STEP SLICER',
  vinyl_flick: 'VINYL FLICK (EXPERIMENTAL)',
  preamp: 'PREAMP',
  synth: 'SYNTH',
  g2b: 'G2B',
  transpose: 'TRANSPOSE',
  pitch_bend: 'PITCH BEND',
  hrm_manual: 'HRM MANUAL',
  hrm_auto_m: 'HRM AUTO (M)',
  octave: 'OCTAVE',
  vocoder: 'VOCODER',
  osc_voc_m: 'OSC VOC (M)',
  osc_bot: 'OSC BOT (CLEAN-ROOM)',
  auto_riff: 'AUTO RIFF (EXPERIMENTAL)',
  robot: 'ROBOT (EXPERIMENTAL)',
  electric: 'ELECTRIC',
};

const NATIVE_CATALOG_FX_IDS = Object.fromEntries(
  Object.entries(NATIVE_CATALOG_FX_LABELS).map(([effectId, label]) => [label, effectId]),
) as Readonly<Record<string, string>>;

export interface NativeCatalogFxState {
  type: string;
  value: number;
  active: boolean;
  /** Effect-specific named controls, persisted independently of the macro. */
  parameters?: Record<string, number>;
}

export function nativeCatalogEffectId(label: string): string | null {
  // Keep older locally-saved labels readable after the selector began showing
  // the experimental status explicitly.
  if (label === 'VINYL FLICK') return 'vinyl_flick';
  if (label === 'REVERSE REVERB') return 'reverse_reverb';
  if (label === 'ROBOT') return 'robot';
  return NATIVE_CATALOG_FX_IDS[label] ?? null;
}

export function nativeCatalogFxOptions(status: NativeStatus | null, path: NativeFxPath): string[] {
  const nativeFx = status?.nativeFx;
  if (!nativeFx?.catalogGraphAvailable || !nativeFx.implementedCatalogEffects || !nativeFx.catalogEffectAvailability) {
    return [];
  }
  const implemented = new Set(nativeFx.implementedCatalogEffects);
  return nativeFx.catalogEffectAvailability
    .filter((entry) => entry[path] && implemented.has(entry.effectId) && NATIVE_CATALOG_FX_LABELS[entry.effectId])
    .map((entry) => NATIVE_CATALOG_FX_LABELS[entry.effectId]!);
}

/** Generic 0–100 panel amount mapped to the Native catalog's semantic controls. */
export function nativeCatalogMacroParameters(type: string, amount: number): Record<string, number> {
  const value = Number.isFinite(amount) ? Math.max(0, Math.min(100, amount)) / 100 : 0;
  switch (nativeCatalogEffectId(type)) {
    case 'filter.lpf':
    case 'filter.bpf':
    case 'filter.hpf':
      return { cutoff_hz: 20 * (1000 ** value) };
    case 'phaser':
      return { depth: value, wet_mix: value };
    case 'flanger':
      return { depth: value, wet_mix: value };
    case 'dynamics':
      return { threshold_db: -18, ratio: 1 + (19 * value), knee_db: 6, attack_ms: 10, release_ms: 120, output_gain_db: 0, detector: 0 };
    case 'dist':
      return { drive_db: 36 * value, mix_percent: value * 100 };
    case 'preamp':
      return { model: 0, gain: value * 100, bass: 0, middle: 0, treble: 0, level: 0 };
    case 'synth':
      return { sensitivity: 60, waveform: 0, octave: 0, tone: 4000, mix: value * 100 };
    case 'electric':
      return { character: 0, 'pitch-snap': 50, tone: 5000, mix: value * 100 };
    case 'osc_voc_m':
      return { waveform: 0, 'midi-channel': 1, octave: 0, mix: value * 100 };
    case 'osc_bot':
      return {
        bands: 16,
        waveform: 1,
        pattern: 0,
        tone: 3000,
        tempo: Number.isFinite(Transport.getInstance().bpm)
          ? Math.max(30, Math.min(300, Transport.getInstance().bpm))
          : 120,
        mix: value * 100,
      };
    case 'auto_riff':
      return {
        bpm: Number.isFinite(Transport.getInstance().bpm)
          ? Math.max(30, Math.min(300, Transport.getInstance().bpm))
          : 120,
        scale: 0,
        rate_beats: 0.5,
        sensitivity_percent: 55,
        mix_percent: value * 100,
      };
    case 'g2b':
      return { tracking_percent: 65, blend_percent: value * 100, body_hz: 180 };
    case 'transpose':
      return { shift_semitones: (value * 48) - 24, mix_percent: 100 };
    case 'pitch_bend':
      return { range: value * 24, time_ms: 500, direction: 0, mix_percent: 100 };
    case 'hrm_manual':
      return { voice_1_interval: 7, voice_2_interval: 12, pan_percent: 0, mix_percent: value * 100 };
    case 'octave':
      return {
        minus_24_level: 0,
        minus_12_level: 40,
        plus_12_level: 0,
        mix_percent: value * 100,
      };
    case 'vocoder':
      return { bands: 16, carrier: 1, mix_percent: value * 100 };
    case 'reverb':
    case 'gate_reverb':
      return { wet_mix: value };
    case 'reverse_reverb':
      return {
        bpm: Number.isFinite(Transport.getInstance().bpm)
          ? Math.max(30, Math.min(300, Transport.getInstance().bpm))
          : 120,
        segment_beats: 0.5,
        feedback_percent: 0,
        crossfade_ms: 20,
        decay_seconds: 2,
        damping_cutoff_hz: 8000,
        mix_percent: value * 100,
      };
    case 'beat_repeat':
      return { mix_percent: value * 100 };
    case 'beat_scatter':
      return {
        bpm: Number.isFinite(Transport.getInstance().bpm)
          ? Math.max(40, Math.min(300, Transport.getInstance().bpm))
          : 120,
        mix_percent: value * 100,
      };
    case 'roll':
      return {
        bpm: Number.isFinite(Transport.getInstance().bpm)
          ? Math.max(40, Math.min(300, Transport.getInstance().bpm))
          : 120,
        slice_beats: 0.5,
        decay_percent: 20,
        pitch_semitones: 0,
        direction: 0,
        mix_percent: value * 100,
      };
    case 'freeze':
      return {
        capture_ms: 250,
        mode: 0,
        pitch_semitones: 0,
        freeze: 0,
        mix_percent: value * 100,
      };
    case 'warp':
      return {
        bpm: Number.isFinite(Transport.getInstance().bpm)
          ? Math.max(30, Math.min(300, Transport.getInstance().bpm))
          : 120,
        capture_beats: 1,
        smear_percent: 30,
        pitch_semitones: 0,
        feedback_percent: 20,
        freeze: 0,
        mix_percent: value * 100,
      };
    case 'tape_echo':
      return { mix_percent: value * 100 };
    case 'reverse_delay':
      return {
        bpm: Number.isFinite(Transport.getInstance().bpm)
          ? Math.max(30, Math.min(300, Transport.getInstance().bpm))
          : 120,
        segment_beats: 1,
        feedback_percent: 20,
        crossfade_ms: 20,
        mix_percent: value * 100,
      };
    case 'fractional_delay':
      return { delay_ms: 10 * (200 ** value), feedback: 0.35, wet_mix: value };
    case 'mod_delay':
      return { wet_mix: value };
    case 'panning_delay':
      return { time_ms: 1 + (1999 * value), feedback_percent: 30, pan_percent: 70, mix_percent: value * 100 };
    case 'twist':
      return { amount_percent: (value * 200) - 100 };
    case 'granular_delay':
      return { mix_percent: value * 100 };
    case 'auto_pan':
      return { depth: value, wet_mix: 1 };
    case 'manual_pan':
      return { position: (value * 200) - 100 };
    case 'chorus':
      return { wet_mix: value };
    case 'tremolo':
      return { depth: value, wet_mix: 1 };
    case 'ring_mod':
      return { depth: value, wet_mix: 1 };
    case 'eq':
      return { low_gain_db: 12 * value, high_gain_db: -12 * value };
    case 'isolator':
      return {
        low_crossover_hz: 250, high_crossover_hz: 4000,
        low_gain_db: 12 * value, mid_gain_db: 0, high_gain_db: -12 * value,
        gate_enabled: 0, gate_bpm: 120, gate_division_beats: 0.5,
        gate_duty_percent: 50, gate_attack_ms: 1, gate_release_ms: 25,
      };
    case 'stereo_enhance':
      return { width: 200 * value };
    case 'lo_fi':
      return { mix_percent: value * 100 };
    case 'radio':
      return { drive: value * 100, mix: value * 100 };
    case 'sustainer':
      return { threshold_db: -24, ratio: 1 + (19 * value), release_ms: 180, output_db: 0 };
    case 'vibrato':
      return {
        rate_hz: 0.05 * (400 ** value), depth: 100 * value,
        delay_ms: 0.2 + (9.8 * value), mix_percent: 100 * value,
      };
    case 'slow_gear':
      return { attack_ms: 5 * (400 ** value), sensitivity_percent: 50, mix_percent: 100 };
    case 'pattern_slicer':
      return {
        bpm: Number.isFinite(Transport.getInstance().bpm)
          ? Math.max(30, Math.min(300, Transport.getInstance().bpm))
          : 120,
        pattern: 0,
        rate: 0.25,
        depth: value * 100,
        edge_ms: 2,
      };
    case 'step_slicer': {
      const steps = Object.fromEntries(
        Array.from({ length: 16 }, (_, index) => [`step_${String(index + 1).padStart(2, '0')}`, 100]),
      );
      return {
        step_count: 16,
        rate_beats: 0.25,
        bpm: Number.isFinite(Transport.getInstance().bpm)
          ? Math.max(30, Math.min(300, Transport.getInstance().bpm))
          : 120,
        depth_percent: value * 100,
        pan_depth_percent: 0,
        filter_hz: 20000,
        ...steps,
      };
    }
    case 'vinyl_flick':
      // Centered platter-speed macro: 0 is stopped, 50 is nominal 1x, and
      // 100 is 2x. The dry/wet blend keeps the zero endpoint neutral.
      return {
        speed_percent: ((2 * value) - 1) * 100,
        motor_return_seconds: 1.5,
        brake_percent: 35,
        mix_percent: value * 100,
      };
    default:
      return {};
  }
}

export function nativeCatalogSlotConfig(
  path: NativeFxPath,
  slotIndex: number,
  state: NativeCatalogFxState,
): NativeCatalogSlotConfig | null {
  const effectId = nativeCatalogEffectId(state.type);
  if (slotIndex < 0 || slotIndex >= NATIVE_FX_SLOT_IDS.length) return null;
  if (state.type === '' || state.type === NATIVE_CATALOG_EMPTY_LABEL) {
    return {
      path,
      slot: NATIVE_FX_SLOT_IDS[slotIndex]!,
      effectId: '',
      parameters: {},
      bypassed: false,
    };
  }
  if (!effectId) return null;
  return {
    path,
    slot: NATIVE_FX_SLOT_IDS[slotIndex]!,
    effectId,
    parameters: { ...nativeCatalogMacroParameters(state.type, state.value), ...state.parameters },
    bypassed: !state.active,
  };
}
