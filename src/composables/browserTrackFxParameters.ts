import { FX_CATALOG, type FxParameterOption } from '../audio/fx/catalog';
import { BROWSER_WORKLET_FX_TYPES } from '../audio/fx/BrowserWorkletFX';

export interface BrowserTrackFxControl {
  key: string;
  label: string;
  unit: string;
  min: number;
  max: number;
  defaultValue: number;
  step: number;
  options?: readonly FxParameterOption[];
}

// Catalog metadata is broader than the executable adapter contract. Only
// explicitly mapped numeric controls are offered here. Values use the raw
// BrowserFxParameters units, so percent descriptors are scaled where needed.
type ControlMapping = string | readonly [key: string, scale: number];
const scaled = (value: number, scale: number) => Number((value * scale).toFixed(12));
const mappings: Record<string, Record<string, ControlMapping>> = {
  lpf: { cutoff: 'cutoffHz', mix: ['mix', 0.01] },
  bpf: { center: 'cutoffHz', q: 'q', mix: ['mix', 0.01] },
  hpf: { cutoff: 'cutoffHz', mix: ['mix', 0.01] },
  phaser: { rate: 'phaserRateHz', depth: ['phaserDepth', 0.01], feedback: ['phaserFeedback', 0.01], mix: ['mix', 0.01] },
  flanger: { delay: 'flangerDelayMs', rate: 'flangerRateHz', depth: ['flangerDepth', 0.01], feedback: ['flangerFeedback', 0.01], mix: ['mix', 0.01] },
  synth: { sensitivity: 'synthSensitivity', waveform: 'synthWaveform', octave: 'synthOctave', tone: 'synthToneHz', mix: 'synthMixPercent' },
  'lo-fi': { 'bit-depth': 'loFiBitDepth', 'sample-rate': 'loFiSampleRateHz', filter: 'loFiFilterHz', mix: ['mix', 0.01] },
  radio: { band: 'radioBand', drive: 'radioDrive', noise: 'radioNoise', mix: ['mix', 0.01] },
  'ring-mod': { 'carrier-frequency': 'ringModHz', mix: ['mix', 0.01] },
  g2b: { tracking: 'g2bTrackingPercent', blend: 'g2bBlendPercent', body: 'g2bBodyHz' },
  sustainer: { threshold: 'thresholdDb', ratio: 'ratio', release: 'releaseMs', output: 'outputDb' },
  'slow-gear': { attack: 'slowGearAttackMs', sensitivity: 'slowGearSensitivityPercent', mix: ['mix', 0.01] },
  electric: { character: 'electricCharacter', 'pitch-snap': 'electricPitchSnapPercent', tone: 'electricToneHz', mix: ['mix', 0.01] },
  vocoder: { bands: 'vocoderBands', carrier: 'vocoderCarrier', mix: ['mix', 0.01] },
  'osc-bot': { waveform: 'oscBotWaveform', pattern: 'oscBotPattern', tone: 'oscBotToneHz', mix: ['mix', 0.01] },
  preamp: { model: 'preampModel', gain: 'preampGainPercent', bass: 'preampBassDb', middle: 'preampMiddleDb', treble: 'preampTrebleDb', level: 'preampLevelDb' },
  dist: { drive: ['driveDb', 0.36], level: 'outputDb', mix: ['mix', 0.01] },
  dynamics: { threshold: 'thresholdDb', ratio: 'ratio', attack: 'attackMs', release: 'releaseMs', output: 'outputDb' },
  eq: {
    'low-frequency': 'eqLowFrequencyHz', 'low-gain': 'eqLowGainDb',
    'mid-1-frequency': 'eqMid1FrequencyHz', 'mid-1-q': 'eqMid1Q', 'mid-1-gain': 'eqMid1GainDb',
    'mid-2-frequency': 'eqMid2FrequencyHz', 'mid-2-q': 'eqMid2Q', 'mid-2-gain': 'eqMid2GainDb',
    'high-frequency': 'eqHighFrequencyHz', 'high-gain': 'eqHighGainDb',
  },
  isolator: { low: 'isolatorLowGainDb', mid: 'isolatorMidGainDb', high: 'isolatorHighGainDb', 'gate-rate': 'isolatorGateRateBeats', 'gate-depth': 'isolatorGateDepthPercent' },
  'auto-pan': { rate: 'autoPanRateHz', depth: ['autoPanDepth', 0.01] },
  'manual-pan': { position: ['manualPanPosition', 0.01] },
  'stereo-enhance': { width: ['stereoWidth', 0.01], 'low-mono-cutoff': 'stereoLowMonoCutoffHz', decorrelation: ['stereoDecorrelation', 0.01], mix: ['mix', 0.01] },
  tremolo: { rate: 'tremoloRateHz', depth: ['tremoloDepth', 0.01] },
  vibrato: { rate: 'vibratoRateHz', depth: 'vibratoDepthPercent', delay: 'vibratoDelayMs', mix: ['mix', 0.01] },
  'pattern-slicer': { pattern: 'patternSlicerPattern', rate: 'patternSlicerRateBeats', depth: 'patternSlicerDepthPercent', edge: 'patternSlicerEdgeMs' },
  'step-slicer': { 'step-count': 'stepSlicerStepCount', rate: 'stepSlicerRateBeats', depth: 'stepSlicerDepthPercent', 'pan-depth': 'stepSlicerPanDepthPercent', filter: 'stepSlicerFilterHz' },
  delay: { time: 'delayTimeMs', feedback: ['delayFeedback', 0.01], tone: 'delayToneHz', mix: ['mix', 0.01] },
  'panning-delay': { time: 'panningDelayTimeMs', feedback: ['panningDelayFeedback', 0.01], pan: ['panningDelayPan', 0.01], mix: ['mix', 0.01] },
  'reverse-delay': { time: 'reverseDelaySegmentBeats', feedback: ['reverseDelayFeedback', 0.01], crossfade: 'reverseDelayCrossfadeMs', mix: ['mix', 0.01] },
  'mod-delay': { time: 'modDelayTimeMs', rate: 'modDelayRateHz', depth: 'modDelayDepthMs', feedback: 'modDelayFeedbackPercent', mix: ['mix', 0.01] },
  'tape-echo': { time: 'tapeEchoTimeMs', feedback: ['tapeEchoFeedback', 0.01], wow: ['tapeEchoWow', 0.01], saturation: ['tapeEchoSaturation', 0.01], tone: 'tapeEchoToneHz', mix: ['mix', 0.01] },
  'granular-delay': { 'grain-size': 'granularGrainSizeMs', density: 'granularDensityHz', pitch: 'granularPitchSemitones', jitter: 'granularPositionJitterPercent', feedback: 'granularFeedbackPercent', mix: ['mix', 0.01] },
  warp: { capture: 'warpCaptureBeats', smear: 'warpSmearPercent', pitch: 'warpPitchSemitones', feedback: 'warpFeedbackPercent', freeze: 'warpFreezeEnabled', mix: ['mix', 0.01] },
  twist: { amount: 'twistAmount', trajectory: 'twistTrajectory', mix: ['mix', 0.01] },
  roll: { slice: 'rollSliceBeats', decay: 'rollDecayPercent', pitch: 'rollPitchSemitones', direction: 'rollDirection', mix: ['mix', 0.01] },
  freeze: { 'capture-length': 'freezeCaptureLengthMs', pitch: 'freezePitchSemitones', mix: ['mix', 0.01] },
  chorus: { rate: 'chorusRateHz', depth: 'chorusDepthMs', feedback: ['chorusFeedback', 0.01], mix: ['mix', 0.01] },
  reverb: { decay: 'decaySeconds', tone: 'dampingHz', mix: ['mix', 0.01] },
  'gate-reverb': { decay: 'decaySeconds', threshold: 'gateThresholdDb', hold: 'gateHoldMs', release: 'gateReleaseMs', mix: ['mix', 0.01] },
  'reverse-reverb': { segment: 'reverseReverbSegmentBeats', feedback: 'reverseReverbFeedbackPercent', crossfade: 'reverseReverbCrossfadeMs', decay: 'reverseReverbDecaySeconds', damping: 'reverseReverbDampingCutoffHz', mix: ['mix', 0.01] },
  'beat-scatter': { slice: 'beatScatterSliceBeats', scatter: 'beatScatterScatterPercent', pitch: 'beatScatterPitchSemitones', repeats: 'beatScatterRepeats', mix: ['mix', 0.01] },
  'beat-repeat': { division: 'division', decay: 'decay', direction: 'direction', mix: ['mix', 0.01] },
};

/** The amount adapter changes these controls; other named edits must survive. */
export function getBrowserTrackFxMacroKeys(type: string): readonly string[] {
  const canonicalType = type.replace(' (EXPERIMENTAL)', '');
  const algorithm = BROWSER_WORKLET_FX_TYPES[canonicalType as keyof typeof BROWSER_WORKLET_FX_TYPES];
  switch (algorithm) {
    case 'lpf': case 'bpf': case 'hpf': return ['cutoffHz'];
    case 'flanger': return ['flangerDepth', 'mix'];
    case 'ring-mod': return ['ringModDepth'];
    case 'phaser': return ['phaserDepth', 'mix'];
    case 'tremolo': return ['tremoloDepth', 'mix'];
    case 'auto-pan': return ['autoPanDepth', 'mix'];
    case 'distortion': return ['driveDb', 'outputDb', 'mix'];
    case 'preamp': return ['preampGainPercent'];
    case 'synth': return ['synthMixPercent'];
    case 'g2b': return ['g2bBlendPercent'];
    case 'vocoder': return ['vocoderBands', 'vocoderCarrier', 'mix'];
    case 'dynamics': return ['thresholdDb', 'ratio', 'kneeDb', 'attackMs', 'releaseMs', 'mix'];
    case 'sustainer': return ['thresholdDb', 'ratio', 'releaseMs', 'outputDb', 'mix'];
    case 'pattern-slicer': return ['patternSlicerDepthPercent'];
    case 'step-slicer': return ['stepSlicerDepthPercent'];
    case 'stereo-enhance': return ['stereoWidth'];
    case 'eq': return ['eqLowGainDb', 'eqHighGainDb', 'mix'];
    case 'manual-pan': return ['manualPanPosition', 'mix'];
    case 'twist': return ['twistAmount'];
    case 'radio': return ['radioDrive', 'mix'];
    case 'vibrato': return ['vibratoDepthPercent', 'mix'];
    case 'isolator': return ['isolatorGateDepthPercent'];
    default: return ['mix'];
  }
}

export function getBrowserTrackFxControls(type: string): BrowserTrackFxControl[] {
  const canonicalType = type.replace(' (EXPERIMENTAL)', '');
  const algorithm = BROWSER_WORKLET_FX_TYPES[canonicalType as keyof typeof BROWSER_WORKLET_FX_TYPES];
  const catalogId = algorithm === 'distortion' ? 'dist' : algorithm;
  const catalog = FX_CATALOG.find((effect) => effect.id === catalogId);
  const mapping = catalogId ? mappings[catalogId] : undefined;
  if (!catalog || !mapping) return [];
  const controls = catalog.parameters.flatMap((parameter): BrowserTrackFxControl[] => {
    const mapped = mapping[parameter.key];
    if (!mapped) return [];
    const [key, scale] = typeof mapped === 'string' ? [mapped, 1] : mapped;
    return [{
      key,
      label: parameter.label,
      unit: scale === 0.01 ? '0–1' : key === 'driveDb' ? 'dB' : parameter.unit,
      min: scaled(parameter.range.min, scale),
      max: scaled(parameter.range.max, scale),
      defaultValue: scaled(parameter.defaultValue, scale),
      step: key === 'vocoderBands' || parameter.options || parameter.curve === 'stepped' ? scale : scale < 1 ? 0.01 : 0.1,
      options: parameter.options?.map((option) => ({ ...option, value: scaled(option.value, scale) })),
    }];
  });
  if (algorithm === 'step-slicer') {
    for (let index = 1; index <= 16; index += 1) {
      controls.push({ key: `stepSlicerStep${String(index).padStart(2, '0')}`, label: `Step ${index}`, unit: '%', min: 0, max: 100, defaultValue: 100, step: 1 });
    }
  }
  if (algorithm === 'freeze') {
    controls.push({ key: 'freezeEnabled', label: 'Capture / freeze', unit: 'choice', min: 0, max: 1, defaultValue: 0, step: 1, options: [{ value: 0, label: 'Live' }, { value: 1, label: 'Frozen' }] });
  }
  return controls;
}

/** Drop unknown/non-finite fields, clamp ranges and snap enumerated choices. */
export function sanitizeBrowserTrackFxParameters(type: string, raw: unknown): Record<string, number> {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const result: Record<string, number> = {};
  for (const control of getBrowserTrackFxControls(type)) {
    const value = source[control.key];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    let bounded = Math.max(control.min, Math.min(control.max, value));
    if (control.options?.length) {
      bounded = control.options.reduce((nearest, option) => Math.abs(option.value - bounded) < Math.abs(nearest.value - bounded) ? option : nearest).value;
    } else if (control.step === 1) bounded = Math.round(bounded);
    result[control.key] = bounded;
  }
  return result;
}
