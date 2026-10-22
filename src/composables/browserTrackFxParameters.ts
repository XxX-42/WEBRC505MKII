import { BROWSER_OFFICIAL_SOURCE_ALGORITHMS } from '../audio/fx/dsp/OfficialBrowserParameters';
import { BROWSER_OFFICIAL_PARAMETER_KEYS } from '../audio/fx/official/browserBindings';
import { isOfficialFxSlotAllowed, findOfficialRuntimeParameter, resolveOfficialEffect, officialParameterDomain, encodeOfficialValue, isOfficialRuntimeValueValid } from '../audio/fx/official/parameters';
import { FX_CATALOG, type FxParameterOption } from '../audio/fx/catalog';
import { BROWSER_WORKLET_FX_TYPES } from '../audio/fx/BrowserWorkletFX';
import { BROWSER_PER_TRACK_FX_TYPES } from '../audio/BrowserTrackFxChain';

export interface BrowserTrackFxControl {
  key: string;
  provenance?: 'official-interface' | 'extension' | 'routing';
  label: string;
  unit: string;
  min: number;
  max: number;
  defaultValue: number;
  step: number;
  hint?: string;
  options?: readonly FxParameterOption[];
  specialOptions?: readonly FxParameterOption[];
}

// Catalog metadata is broader than the executable adapter contract. Only
// explicitly mapped numeric controls are offered here. Values use the raw
// BrowserFxParameters units, so percent descriptors are scaled where needed.
type ControlMapping = string | readonly [key: string, scale: number];
const scaled = (value: number, scale: number) => Number((value * scale).toFixed(12));
const mappings: Record<string, Record<string, ControlMapping>> = {
  lpf: { cutoff: 'cutoffHz', resonance: 'filterResonancePercent', mix: ['mix', 0.01] },
  bpf: { center: 'cutoffHz', q: 'q', mix: ['mix', 0.01] },
  hpf: { cutoff: 'cutoffHz', resonance: 'filterResonancePercent', mix: ['mix', 0.01] },
  phaser: { rate: 'phaserRateHz', depth: ['phaserDepth', 0.01], feedback: ['phaserFeedback', 0.01], mix: ['mix', 0.01] },
  flanger: { delay: 'flangerDelayMs', rate: 'flangerRateHz', depth: ['flangerDepth', 0.01], feedback: ['flangerFeedback', 0.01], mix: ['mix', 0.01] },
  synth: { sensitivity: 'synthSensitivity', waveform: 'synthWaveform', octave: 'synthOctave', tone: 'synthToneHz', mix: 'synthMixPercent' },
  'lo-fi': { 'bit-depth': 'loFiBitDepth', 'sample-rate': 'loFiSampleRateHz', filter: 'loFiFilterHz', mix: ['mix', 0.01] },
  radio: { band: 'radioBand', drive: 'radioDrive', noise: 'radioNoise', mix: ['mix', 0.01] },
  'ring-mod': { 'carrier-frequency': 'ringModHz', waveform: 'ringModWaveform', mix: ['mix', 0.01] },
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
  transpose: { shift: 'shift', mix: 'mix' },
  'pitch-bend': { range: 'range', time_ms: 'time_ms', direction: 'direction', mix_percent: 'mix_percent' },
  robot: { pitch: 'pitch', formant: 'formant', mix: 'mix' },
  'hrm-manual': { voice_1_interval: 'voice_1_interval', voice_2_interval: 'voice_2_interval', pan_percent: 'pan_percent', mix_percent: 'mix_percent' },
  octave: { minus_24_level: 'minus_24_level', minus_12_level: 'minus_12_level', plus_12_level: 'plus_12_level', mix_percent: 'mix_percent' },
  'auto-riff': { scale: 'scale', rate: 'rate_beats', sensitivity: 'sensitivity_percent', mix: 'mix_percent' },
  'hrm-auto-m': { key: 'key', scale: 'scale', 'midi-channel': 'midi-channel', mix: 'mix' },
  'osc-voc': { waveform: 'waveform', 'midi-channel': 'midi-channel', octave: 'octave', mix: ['mix', 0.01] },
};

/** The amount adapter changes these controls; other named edits must survive. */
export function getBrowserTrackFxMacroKeys(type: string): readonly string[] {
  const canonicalType = type.replace(' (EXPERIMENTAL)', '');
  if (canonicalType === 'TRANSPOSE') return ['shift'];
  if (canonicalType === 'PITCH BEND') return ['range'];
  if (canonicalType === 'ROBOT') return ['mix'];
  if (canonicalType === 'HRM MANUAL') return ['mix_percent'];
  if (canonicalType === 'OCTAVE') return ['mix_percent'];
  if (canonicalType === 'AUTO RIFF') return ['mix_percent'];
  if (canonicalType === 'HRM AUTO (M)') return ['mix'];
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

export function getBrowserTrackFxControls(type: string, currentParameters: Readonly<Record<string, number>> = {}, slotIndex = 0, route: 'private' | 'shared' = 'private'): BrowserTrackFxControl[] {
  const canonicalType = type.replace(' (EXPERIMENTAL)', '');
  // Catalog metadata alone does not admit an effect on the private chain. HRM
  // AUTO controls become visible only when the chain advertises its executable route.
  if (canonicalType === 'HRM AUTO (M)' && !BROWSER_PER_TRACK_FX_TYPES.includes(canonicalType)) return [];
  const algorithm = BROWSER_WORKLET_FX_TYPES[canonicalType as keyof typeof BROWSER_WORKLET_FX_TYPES];
  const catalogId = algorithm === 'distortion' ? 'dist' : algorithm === 'osc-voc' ? 'osc-voc-m' : algorithm ?? (canonicalType === 'TRANSPOSE' ? 'transpose' : canonicalType === 'PITCH BEND' ? 'pitch-bend' : canonicalType === 'ROBOT' ? 'robot' : canonicalType === 'HRM MANUAL' ? 'hrm-manual' : canonicalType === 'OCTAVE' ? 'octave' : canonicalType === 'AUTO RIFF' ? 'auto-riff' : canonicalType === 'HRM AUTO (M)' ? 'hrm-auto-m' : null);
  const catalog = FX_CATALOG.find((effect) => effect.id === catalogId);
  const mapping = catalogId === 'osc-voc-m' ? mappings['osc-voc'] : catalogId ? mappings[catalogId] : undefined;
  if (!catalog || (!mapping && !BROWSER_OFFICIAL_SOURCE_ALGORITHMS.includes(algorithm ?? ''))) return [];
  const controls = catalog.parameters.flatMap((parameter): BrowserTrackFxControl[] => {
    const mapped = mapping?.[parameter.key];
    if (!mapped) return [];
    const [key, scale] = typeof mapped === 'string' ? [mapped, 1] : mapped;
    return [{
      key,
      label: parameter.label,
      unit: scale === 0.01 ? '0–1' : key === 'driveDb' ? 'dB' : parameter.unit,
      min: scaled(parameter.range.min, scale),
      max: scaled(parameter.range.max, scale),
      defaultValue: scaled(parameter.defaultValue, scale),
      step: key === 'vocoderBands' || parameter.key === 'midi-channel' || parameter.options || parameter.curve === 'stepped' ? scale : scale < 1 ? 0.01 : 0.1,
      ...(parameter.runtimeMapping ? { hint: parameter.runtimeMapping } : {}),
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
  for (const control of controls) control.provenance = 'extension';
  const official = resolveOfficialEffect(canonicalType, currentParameters);
  const admitted = BROWSER_OFFICIAL_PARAMETER_KEYS[algorithm ?? (String(catalogId) === 'hrm-auto-m' ? 'hrm-auto' : catalogId) ?? ''] ?? [];
  if (!isOfficialFxSlotAllowed(type, 'track', slotIndex) || (route === 'private' && BROWSER_OFFICIAL_SOURCE_ALGORITHMS.includes(algorithm ?? ''))) return controls;
  const officialControls: BrowserTrackFxControl[] = [];
  if (admitted.includes('official_variant') && (canonicalType === 'TAPE ECHO' || canonicalType === 'ROLL')) {
    officialControls.push({ key: 'official_variant', provenance: 'routing', label: 'RC algorithm variant', unit: 'variant', min: 1, max: 2, step: 1, defaultValue: 1,
      options: [{ value: 1, label: `${canonicalType}1` }, { value: 2, label: `${canonicalType}2` }],
      hint: 'Choose a variant explicitly. Until selected the saved legacy algorithm remains unchanged; changing variant clears incompatible official settings.' });
  }
  if (admitted.includes('official_step_index')) officialControls.push({ key: 'official_step_index', provenance: 'routing', label: 'RC edited step', unit: 'step', min: 1, max: 16, step: 1, defaultValue: 1, options: Array.from({ length: 16 }, (_, i) => ({ value: i + 1, label: String(i + 1) })), hint: 'Select which STEP LEVEL is edited. All 16 step levels are retained in recovery state.' });
  for (const parameter of official?.parameters ?? []) {
    const selectedStep = Math.max(1, Math.min(16, Math.round(currentParameters.official_step_index ?? 1)));
    const key = official?.name === 'STEP SLICER' && parameter.key === 'step_level' ? `official_step_level_${selectedStep}` : `official_${parameter.key}`;
    if (!admitted.includes(key)) continue;
    const domain = officialParameterDomain(parameter);
    let options = domain.options.map(choice => ({ value: choice.runtime, label: choice.label }));
    const trackCarrierOnly = algorithm === 'vocoder' && key === 'official_carrier';
    if (trackCarrierOnly) options = options.filter(choice => choice.value >= 6 && choice.value <= 10);
    // Mixed tempo/manual domains are a finite UI enumeration, not a continuous
    // negative-to-positive slider that would admit undocumented sync values.
    if (options.length && domain.range) {
      const count = Math.round((domain.range.max-domain.range.min)/domain.range.step)+1;
      if (count <= 1001) for (let i = 0; i < count; i++) {
        const value = Number((domain.range.min + i * domain.range.step).toFixed(7));
        options.push({ value, label: `${value}${domain.unit ? ` ${domain.unit}` : ''}` });
      }
    }
    const numbers = options.map(choice => choice.value);
    if (domain.range) numbers.push(domain.range.min, domain.range.max);
    if (!numbers.length) continue;
    const documentedDefault = parameter.default === null ? null : encodeOfficialValue(parameter, parameter.default);
    officialControls.push({ key, provenance: 'official-interface', label: `RC · ${parameter.name}`, unit: domain.unit,
      min: Math.min(...numbers), max: Math.max(...numbers), step: domain.range?.step ?? 1,
      defaultValue: documentedDefault ?? options[0]?.value ?? domain.range?.min ?? 0,
      hint: `RC-505mkII Parameter Guide p.${official!.page}. The first RC edit initializes supported documented RC defaults. Clean-room DSP mapping; hardware sound parity not verified.${trackCarrierOnly ? ' PARTIAL_SOURCE_MODES: TRACK1–5 playback-only source before the track strip; empty/stopped tracks are silent. The six physical MIC/INST inputs are not mapped, and CARRIER THRU is unavailable.' : ''}${BROWSER_OFFICIAL_SOURCE_ALGORITHMS.includes(algorithm ?? '') ? ' PARTIAL_SOURCE_MODES: shared Track A loop-source playback only; reverse/live pitch/overdub modes are not supported.' : ''}${documentedDefault === null ? ' No documented default; displayed fallback is software-only.' : ''}${!domain.complete ? ' Manual does not enumerate all intermediate choices.' : ''}${parameter.notes ? ` ${parameter.notes}` : ''}`,
      ...(options.length && (!domain.range || (domain.range.max-domain.range.min)/domain.range.step <= 1000) ? { options } : options.length ? { specialOptions: options } : {}),
    });
  }
  return [...officialControls, ...controls];
}

/**
 * Browser Input FX controls are the same authored worklet controls as the
 * per-track bank, but only expose them when the catalog declares an actual
 * Browser input-bank route. This keeps read-head/source-only controls and
 * track-only adapters out of the Input panel.
 */
export function getBrowserInputFxControls(type: string, currentParameters: Readonly<Record<string, number>> = {}, slotIndex = 0): BrowserTrackFxControl[] {
  const canonicalType = type.replace(' (EXPERIMENTAL)', '');
  const algorithm = BROWSER_WORKLET_FX_TYPES[canonicalType as keyof typeof BROWSER_WORKLET_FX_TYPES];
  const catalogId = algorithm === 'distortion' ? 'dist'
    : algorithm === 'osc-voc' ? 'osc-voc-m'
      : algorithm ?? (canonicalType === 'TRANSPOSE' ? 'transpose'
        : canonicalType === 'PITCH BEND' ? 'pitch-bend'
          : canonicalType === 'ROBOT' ? 'robot'
            : canonicalType === 'HRM MANUAL' ? 'hrm-manual'
              : canonicalType === 'OCTAVE' ? 'octave'
                : canonicalType === 'AUTO RIFF' ? 'auto-riff'
                  : canonicalType === 'HRM AUTO (M)' ? 'hrm-auto-m' : null);
  const catalog = FX_CATALOG.find((effect) => effect.id === catalogId);
  const hasInputRoute = catalog?.runtimeImplementations?.some((implementation) =>
    implementation.runtime === 'browser' && implementation.target === 'input-bank-slot');
  return hasInputRoute ? getBrowserTrackFxControls(type, currentParameters, slotIndex).filter(control => control.provenance !== 'official-interface' || isOfficialFxSlotAllowed(type, 'input', slotIndex)) : [];
}

/** Drop unknown/non-finite fields, clamp ranges and snap enumerated choices. */
export function sanitizeBrowserTrackFxParameters(type: string, raw: unknown, currentParameters: Readonly<Record<string, number>> = {}, route: 'private' | 'shared' = 'shared'): Record<string, number> {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const context = { ...currentParameters, ...source } as Record<string, number>;
  const result: Record<string, number> = {};
  for (const control of getBrowserTrackFxControls(type, context, 0, route)) {
    const value = source[control.key];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    if (control.provenance === 'routing') { if (Number.isInteger(value) && value >= control.min && value <= control.max) result[control.key] = value; continue; }
    if (control.provenance === 'official-interface') {
      const parameter = findOfficialRuntimeParameter(resolveOfficialEffect(type, context), control.key);
      if (parameter && isOfficialRuntimeValueValid(parameter, value)) result[control.key] = value;
      continue;
    }
    let bounded = Math.max(control.min, Math.min(control.max, value));
    if (control.options?.length) {
      bounded = control.options.reduce((nearest, option) => Math.abs(option.value - bounded) < Math.abs(nearest.value - bounded) ? option : nearest).value;
    } else if (control.step === 1) bounded = Math.round(bounded);
    result[control.key] = bounded;
  }
  if (resolveOfficialEffect(type, context)?.name === 'STEP SLICER' && getBrowserTrackFxControls(type, context, 0, route).some(control => control.key === 'official_step_index')) {
    const parameter = findOfficialRuntimeParameter(resolveOfficialEffect(type, context), 'official_step_level_1');
    for (let i = 1; i <= 16; i++) {
      const key = `official_step_level_${i}`;
      const value = source[key];
      if (parameter && typeof value === 'number' && isOfficialRuntimeValueValid(parameter, value)) result[key] = value;
    }
  }
  return result;
}
