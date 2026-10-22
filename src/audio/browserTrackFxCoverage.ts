import { FX_CATALOG } from './fx/catalog';
import { BROWSER_WORKLET_FX_TYPES } from './fx/BrowserWorkletFX';
import { BROWSER_PER_TRACK_FX_TYPES, BROWSER_PER_TRACK_FX_UNSUPPORTED, BROWSER_PER_TRACK_PARAMETER_KEYS } from './BrowserTrackFxChain';

/** Full 53-effect coverage matrix for the bounded real Browser insert route. */
export const BROWSER_TRACK_FX_COVERAGE = FX_CATALOG.map((entry) => {
  const type = entry.displayName === 'LPF' || entry.displayName === 'BPF' || entry.displayName === 'HPF'
    ? `DSP ${entry.displayName}` : entry.displayName === 'REVERB' ? 'FDN8 REVERB' : entry.displayName;
  const supported = BROWSER_PER_TRACK_FX_TYPES.includes(type);
  const algorithm = BROWSER_WORKLET_FX_TYPES[type as keyof typeof BROWSER_WORKLET_FX_TYPES];
  const parameterAlgorithm = algorithm ?? (type === 'TRANSPOSE' ? 'transpose' : type === 'PITCH BEND' ? 'pitch-bend' : type === 'ROBOT' ? 'robot' : type === 'HRM MANUAL' ? 'hrm-manual' : type === 'OCTAVE' ? 'octave' : type === 'AUTO RIFF' ? 'auto-riff' : type === 'HRM AUTO (M)' ? 'hrm-auto' : null);
  return {
    catalogId: entry.id,
    catalogName: entry.displayName,
    type,
    supported,
    route: supported ? 'per-track-pre-mix' as const : 'rejected' as const,
    implementationStatus: entry.implementationStatus,
    numericParameters: supported
      ? parameterAlgorithm ? BROWSER_PER_TRACK_PARAMETER_KEYS[parameterAlgorithm] ?? [] : []
      : [],
    reason: supported ? null : BROWSER_PER_TRACK_FX_UNSUPPORTED[type as keyof typeof BROWSER_PER_TRACK_FX_UNSUPPORTED]
      ?? `No admitted per-track Browser adapter for ${entry.displayName}.`,
  };
});
