import { officialDynamicsProfile } from './OfficialDynamicsProfiles';
import { encodeOfficialValue, resolveOfficialEffect } from '../official/parameters';
import type { BrowserFxAlgorithm, BrowserFxParameters } from './BrowserFxDspCore';

/** Public manual names are deliberately separate from the legacy authored controls.
 * These are functional, clean-room mappings, not measurements of Roland's DSP laws.
 * Tempo: 0..100 = authored free rate, negative = quarter-note beats, -1000 = OFF.
 */
export const OFFICIAL_OFF = -1000;
const keys = (...names: string[]): readonly string[] => Object.freeze(names.map(name => `official_${name}`));
export const BROWSER_OFFICIAL_PARAMETER_KEYS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  lpf: keys('rate', 'depth', 'resonance', 'cutoff', 'step_rate'),
  bpf: keys('rate', 'depth', 'resonance', 'cutoff', 'step_rate'),
  hpf: keys('rate', 'depth', 'resonance', 'cutoff', 'step_rate'),
  phaser: keys('rate', 'depth', 'resonance', 'manual', 'step_rate', 'd_level', 'e_level', 'stage'),
  flanger: keys('rate', 'depth', 'resonance', 'manual', 'step_rate', 'd_level', 'e_level', 'separation'),
  'lo-fi': keys('bitdepth', 'samplerate', 'balance'),
  radio: keys('lo_fi', 'level'),
  'ring-mod': keys('frequency', 'balance'),
  sustainer: keys('attack', 'release', 'level', 'low_gain', 'hi_gain', 'sustain'),
  distortion: keys('type', 'tone', 'dist', 'd_level', 'e_level'),
  eq: keys('lo', 'lo_mid', 'lo_mid_freq', 'lo_mid_q', 'hi_mid', 'hi_mid_freq', 'hi_mid_q', 'high', 'level'),
  'slow-gear': keys('sens', 'rise_time', 'level'),
  tremolo: keys('rate', 'depth', 'waveform'),
  'auto-pan': keys('rate', 'depth', 'waveform', 'init_phase', 'step_rate'),
  'manual-pan': keys('position'),
  vibrato: keys('rate', 'depth', 'color', 'd_level', 'e_level'),
  'stereo-enhance': keys('low_cut', 'high_cut', 'enhance'),
  chorus: keys('rate', 'depth', 'd_level', 'low_cut', 'high_cut', 'e_level'),
  reverb: keys('time', 'pre_delay', 'density', 'd_level', 'low_cut', 'high_cut', 'e_level'),
  'reverse-reverb': keys('time', 'pre_delay', 'gate_time', 'd_level', 'low_cut', 'high_cut', 'e_level'),
  'pattern-slicer': keys('rate', 'duty', 'attack', 'depth', 'comp_threshold', 'comp_gain'),
  'beat-shift': keys('type', 'shift'),
  'vinyl-flick': keys('flick'),
  'beat-repeat': keys('type', 'length'),
  'beat-scatter': keys('length'),
  'gate-reverb': keys('time', 'pre_delay', 'threshold', 'd_level', 'low_cut', 'high_cut', 'e_level'),
  synth: keys('frequency', 'resonance', 'decay', 'balance'),
  g2b: keys('balance'),
  isolator: keys('band', 'rate', 'band_level', 'depth', 'step_rate', 'waveform'),
  delay: keys('time', 'feedback', 'd_level', 'low_cut', 'high_cut', 'e_level'),
  'panning-delay': keys('time', 'feedback', 'd_level', 'low_cut', 'high_cut', 'e_level'),
  'reverse-delay': keys('time', 'feedback', 'd_level', 'low_cut', 'high_cut', 'e_level'),
  'mod-delay': keys('time', 'feedback', 'mod_depth', 'd_level', 'low_cut', 'high_cut', 'e_level'),
  'granular-delay': keys('time', 'feedback', 'e_level'),
  warp: keys('level'),
  twist: keys('release', 'rise', 'fall', 'level'),
  freeze: keys('attack', 'release', 'decay', 'sustain', 'balance'),
  dynamics: keys('type', 'dynamics'),
  preamp: keys('amp_type', 'spk_type', 'gain', 't_comp', 'bass', 'middle', 'treble', 'presence', 'mic_type', 'mic_dis', 'mic_pos', 'e_level'),
  electric: keys('shift', 'formant', 'speed', 'stability', 'scale'),
  vocoder: keys('carrier', 'tone', 'attack', 'mod_sens', 'balance'),
  'osc-voc': keys('carrier', 'tone', 'attack', 'octave', 'mod_sens', 'release', 'balance'),
  'osc-bot': keys('osc', 'tone', 'attack', 'note', 'mod_sens', 'balance'),
  roll: keys('variant', 'time', 'feedback', 'repeat', 'roll', 'balance'),
  'step-slicer': keys('rate', 'step_max', 'step_length', 'depth', 'comp_threshold', 'comp_gain', 'step_index', ...Array.from({ length: 16 }, (_, i) => `step_level_${i + 1}`)),
  'tape-echo': keys('variant', 'repeat_rate', 'intensity', 'd_level', 'bass', 'treble', 'low_cut', 'high_cut', 'e_level'),
});

/** These controls require the stored-loop source reader. The causal DSP core
 * deliberately rejects them instead of substituting a history approximation.
 * They remain partial_source_modes: reverse/live-pitch/overdub are unavailable. */
export const BROWSER_OFFICIAL_SOURCE_ALGORITHMS: readonly string[] = Object.freeze(['beat-shift', 'vinyl-flick']);

/** Variant is software routing metadata, never a parameter printed in the manual. */
export function isBrowserOfficialParameterSupported(algorithm: string, key: string, variant?: number): boolean {
  if (!(BROWSER_OFFICIAL_PARAMETER_KEYS[algorithm] ?? []).includes(key)) return false;
  if (algorithm !== 'tape-echo' && algorithm !== 'roll') return true;
  if (key === 'official_variant') return true;
  if (variant !== 1 && variant !== 2) return false;
  if (algorithm === 'roll') return variant === 1 ? key !== 'official_repeat' : key !== 'official_feedback';
  return variant === 1 ? key !== 'official_low_cut' && key !== 'official_high_cut'
    : key !== 'official_bass' && key !== 'official_treble';
}

export function getBrowserOfficialDefaults(algorithm: string, variant?: number): Record<string, number> {
  const names: Record<string, string> = { 'ring-mod': 'RING.MOD', distortion: 'DIST', 'lo-fi': 'LO-FI', 'osc-voc': 'OSC VOC (M)' };
  const name = names[algorithm] ?? algorithm.replace(/-/g, ' ').toUpperCase();
  const effect = resolveOfficialEffect(name, { official_variant: variant ?? 0 });
  const defaults: Record<string, number> = {};
  for (const parameter of effect?.parameters ?? []) {
    const key = `official_${parameter.key}`;
    if (algorithm === 'step-slicer' && parameter.key === 'step_level' && parameter.default !== null) {
      const encoded = encodeOfficialValue(parameter, parameter.default);
      if (encoded !== null) for (let i = 1; i <= 16; i += 1) defaults[`official_step_level_${i}`] = encoded;
      continue;
    }
    if (parameter.default === null || !isBrowserOfficialParameterSupported(algorithm, key, variant)) continue;
    const encoded = encodeOfficialValue(parameter, parameter.default);
    if (encoded !== null) defaults[key] = encoded;
  }
  return defaults;
}

export function officialRateHz(value: number, bpm = 120, quarterNotesPerMeasure = 4): number {
  if (!Number.isFinite(value) || value === OFFICIAL_OFF) return 0;
  if (value < 0) {
    // Only the explicitly enumerated MEAS values depend on the meter. Negative
    // ordinary note lengths remain fixed quarter-note counts.
    const meter = Number.isFinite(quarterNotesPerMeasure) ? Math.max(0.125, Math.min(128, quarterNotesPerMeasure)) : 4;
    const beats = Math.abs(value) * (value === -4 || value === -8 || value === -16 ? meter / 4 : 1);
    return Math.min(160, Math.max(40, Math.min(300, Number.isFinite(bpm) ? bpm : 120)) / (60 * Math.max(0.0001, beats)));
  }
  return 0.05 * (400 ** (Math.max(0, Math.min(100, value)) / 100));
}
const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));
const percent = (n: number): number => clamp(n, 0, 100) / 100;

/** Retains official rate selections so host-tempo changes never overwrite the selection. */
export class OfficialBrowserControlState {
  readonly values: Record<string, number> = {};
  bpm = 120;
  quarterNotesPerMeasure = 4;
  readonly algorithm: BrowserFxAlgorithm;
  readonly sampleRate: number;
  constructor(algorithm: BrowserFxAlgorithm, sampleRate: number) { this.algorithm = algorithm; this.sampleRate = sampleRate; }

  has(name: string): boolean { return this.values[`official_${name}`] !== undefined; }
  get(name: string, fallback = 0): number { return this.values[`official_${name}`] ?? fallback; }

  translate(update: BrowserFxParameters): BrowserFxParameters {
    if (BROWSER_OFFICIAL_SOURCE_ALGORITHMS.includes(this.algorithm) && Object.keys(update).some(key => key.startsWith('official_'))) {
      throw new RangeError(`Official ${this.algorithm} controls require a source-aware loop transport; the causal Browser DSP core cannot render them.`);
    }
    // Browser hosts expose only real playback buses. A generic microphone is
    // not a verified RC-505 MIC1/2 or INST1/2 channel and must never stand in.
    if (this.algorithm === 'vocoder' && update.official_carrier !== undefined
      && (!Number.isInteger(update.official_carrier) || update.official_carrier < 6 || update.official_carrier > 10)) {
      throw new RangeError('Browser VOCODER CARRIER supports TRACK1–5 only; MIC1/MIC2/INST1-L/R/INST2-L/R are not mapped.');
    }
    const variant = update.official_variant ?? this.values.official_variant;
    if (update.official_variant !== undefined && update.official_variant !== 1 && update.official_variant !== 2) throw new RangeError('Official FX variant must be 1 or 2');
    // Reject the complete update before mutating retained selections.
    for (const key of Object.keys(update)) {
      if (key.startsWith('official_') && !isBrowserOfficialParameterSupported(this.algorithm, key, variant)) throw new RangeError(`Unsupported official Browser ${this.algorithm} parameter: ${key}`);
    }
    if (update.official_variant !== undefined && update.official_variant !== this.values.official_variant) {
      for (const key of Object.keys(this.values)) delete this.values[key];
    }
    if (Object.keys(this.values).length === 0 && Object.entries(update).some(([key, value]) => key.startsWith('official_') && key !== 'official_step_index' && Number.isFinite(value))) {
      Object.assign(this.values, getBrowserOfficialDefaults(this.algorithm, variant));
    }
    for (const key of Object.keys(update)) {
      if (!key.startsWith('official_') || key === 'official_step_index') continue;
      const value = update[key as `official_${string}`];
      if (Number.isFinite(value)) this.values[key] = value as number;
    }
    const tempoChanged = Number.isFinite(update.bpm);
    if (tempoChanged) this.bpm = clamp(update.bpm as number, 40, 300);
    if (Number.isFinite(update.quarterNotesPerMeasure)) this.quarterNotesPerMeasure = clamp(update.quarterNotesPerMeasure as number, 0.125, 128);
    if (Object.keys(this.values).length === 0) return update;
    const result: BrowserFxParameters = { ...update };
    const v = (name: string, fallback = 0): number => this.get(name, fallback);
    const has = (name: string): boolean => this.has(name);
    if (has('balance')) result.mix = percent(v('balance'));
    if (this.algorithm === 'lpf' || this.algorithm === 'bpf' || this.algorithm === 'hpf') {
      if (has('cutoff')) result.cutoffHz = 20 * (1000 ** percent(v('cutoff')));
      if (has('resonance')) {
        result.q = 0.5 * (40 ** percent(v('resonance')));
        delete result.filterResonancePercent;
      }
    } else if (this.algorithm === 'phaser') {
      if (has('rate')) result.phaserRateHz = officialRateHz(v('rate'), this.bpm, this.quarterNotesPerMeasure);
      if (has('depth')) result.phaserDepth = percent(v('depth'));
      if (has('resonance')) result.phaserFeedback = percent(v('resonance')) * 0.9;
    } else if (this.algorithm === 'flanger') {
      if (has('rate')) result.flangerRateHz = officialRateHz(v('rate'), this.bpm, this.quarterNotesPerMeasure);
      if (has('depth')) result.flangerDepth = percent(v('depth'));
      if (has('resonance')) result.flangerFeedback = percent(v('resonance')) * 0.95;
      if (has('manual')) result.flangerDelayMs = 0.2 + 9.8 * percent(v('manual'));
    } else if (this.algorithm === 'tremolo') {
      if (has('rate')) result.tremoloRateHz = officialRateHz(v('rate'), this.bpm, this.quarterNotesPerMeasure);
      if (has('depth')) result.tremoloDepth = percent(v('depth'));
      result.mix = 1;
    } else if (this.algorithm === 'auto-pan') {
      if (has('rate')) result.autoPanRateHz = officialRateHz(v('rate'), this.bpm, this.quarterNotesPerMeasure);
      if (has('depth')) result.autoPanDepth = percent(v('depth'));
      result.mix = 1;
    } else if (this.algorithm === 'manual-pan') {
      if (has('position')) result.manualPanPosition = clamp(v('position'), -50, 50) / 50;
      result.mix = 1;
    } else if (this.algorithm === 'vibrato') {
      if (has('rate')) result.vibratoRateHz = officialRateHz(v('rate'), this.bpm, this.quarterNotesPerMeasure);
      if (has('depth')) result.vibratoDepthPercent = clamp(v('depth'), 0, 100);
    } else if (this.algorithm === 'stereo-enhance') {
      if (has('enhance')) { result.stereoWidth = 1 + percent(v('enhance')); result.stereoDecorrelation = percent(v('enhance')); }
      result.mix = 1;
    } else if (this.algorithm === 'chorus') {
      if (has('rate')) result.chorusRateHz = officialRateHz(v('rate'), this.bpm, this.quarterNotesPerMeasure);
      if (has('depth')) result.chorusDepthMs = 10 * percent(v('depth'));
    } else if (this.algorithm === 'reverb' || this.algorithm === 'gate-reverb') {
      if (has('time')) result.decaySeconds = clamp(v('time'), 0.1, 10);
      if (has('threshold')) result.gateThresholdDb = -60 + 60 * percent(v('threshold'));
    } else if (this.algorithm === 'synth') {
      if (has('balance')) result.synthMixPercent = clamp(v('balance'), 0, 100);
    } else if (this.algorithm === 'g2b') {
      if (has('balance')) result.g2bBlendPercent = clamp(v('balance'), 0, 100);
    } else if (this.algorithm === 'tape-echo' && has('variant')) {
      if (has('intensity')) result.tapeEchoFeedback = 0.95 * clamp(v('intensity'), 0, 100);
    } else if (this.algorithm === 'granular-delay') {
      // The manual calls FEEDBACK the repeated portion's length, not regeneration.
      if (has('time')) result.granularDensityHz = 80 ** (1 - percent(v('time')));
      if (has('feedback')) result.granularGrainSizeMs = 10 * 100 ** percent(v('feedback'));
    } else if (this.algorithm === 'isolator') {
      result.mix = 1;
    } else if (this.algorithm === 'radio') {
      if (has('lo_fi')) {
        const amount = (clamp(v('lo_fi'), 1, 10) - 1) / 9;
        result.radioBand = amount < 0.34 ? 2 : amount < 0.67 ? 1 : 0;
        result.radioDrive = 5 + amount * 90;
        result.radioNoise = amount * 30;
        result.mix = 1;
      }
    } else if (this.algorithm === 'ring-mod') {
      if (has('frequency')) result.ringModHz = 0.1 * (80000 ** percent(v('frequency')));
      result.ringModDepth = 1;
    } else if (this.algorithm === 'electric') {
      result.mix = 1;
    } else if (this.algorithm === 'dynamics') {
      // TYPE's unmarked manual default uses an explicit software fallback (0).
      const profile = officialDynamicsProfile(v('type', 0));
      const dynamics = clamp(v('dynamics'), -20, 20);
      result.thresholdDb = clamp(profile.threshold + dynamics * 0.18, -60, 0);
      result.ratio = clamp(profile.ratio ** (1 - dynamics / 30), 1, 20);
      result.kneeDb = profile.knee; result.attackMs = profile.attack; result.releaseMs = profile.release;
      result.outputDb = profile.makeup; result.dynamicsDetector = profile.detector; result.mix = 1;
    } else if (this.algorithm === 'sustainer') {
      if (has('attack')) result.attackMs = 0.1 + 99.9 * percent(v('attack')) ** 2;
      if (has('release')) result.releaseMs = 10 * (100 ** percent(v('release')));
      if (has('sustain')) { result.thresholdDb = -12 - 36 * percent(v('sustain')); result.ratio = 1 + 19 * percent(v('sustain')); }
      result.mix = 1;
    } else if (this.algorithm === 'distortion') {
      const type = Math.round(clamp(v('type', 2), 0, 5));
      const amount = percent(v('dist', 50));
      const base = [4, 0, 8, 12, 18, 14][type] ?? 8;
      result.driveDb = clamp(base + amount * (type === 1 ? 12 : 24), 0, 36);
      result.distortionMode = type === 3 || type === 4 ? 'hard-clip' : type === 5 ? 'fuzz' : 'overdrive';
    } else if (this.algorithm === 'eq') {
      if (has('lo')) result.eqLowGainDb = clamp(v('lo'), -20, 20);
      if (has('lo_mid')) result.eqMid1GainDb = clamp(v('lo_mid'), -20, 20);
      if (has('lo_mid_freq')) result.eqMid1FrequencyHz = clamp(v('lo_mid_freq'), 20, 10000);
      if (has('lo_mid_q')) result.eqMid1Q = clamp(v('lo_mid_q'), 0.5, 16);
      if (has('hi_mid')) result.eqMid2GainDb = clamp(v('hi_mid'), -20, 20);
      if (has('hi_mid_freq')) result.eqMid2FrequencyHz = clamp(v('hi_mid_freq'), 20, 10000);
      if (has('hi_mid_q')) result.eqMid2Q = clamp(v('hi_mid_q'), 0.5, 16);
      if (has('high')) result.eqHighGainDb = clamp(v('high'), -20, 20);
      result.mix = 1;
    } else if (this.algorithm === 'beat-repeat') {
      result.division = v('length', -1) === OFFICIAL_OFF ? 1 : Math.abs(v('length', -1));
      result.direction = v('type', 0);
      result.decay = 0;
      result.mix = v('length', -1) === OFFICIAL_OFF ? 0 : 1;
    } else if (this.algorithm === 'beat-scatter') {
      result.beatScatterSliceBeats = v('length', -1) === OFFICIAL_OFF ? 1 : Math.abs(v('length', -1));
      result.mix = v('length', -1) === OFFICIAL_OFF ? 0 : 1;
    } else if (this.algorithm === 'slow-gear') {
      if (has('sens')) result.slowGearSensitivityPercent = clamp(v('sens'), 0, 100);
      if (has('rise_time')) result.slowGearAttackMs = 5 * (400 ** percent(v('rise_time')));
      result.mix = 1;
    }
    return result;
  }
}
