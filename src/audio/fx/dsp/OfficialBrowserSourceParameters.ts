import { findOfficialRuntimeParameter, isOfficialRuntimeValueValid, resolveOfficialEffect } from '../official/parameters';
import { BROWSER_OFFICIAL_SOURCE_ALGORITHMS, getBrowserOfficialDefaults, isBrowserOfficialParameterSupported } from './OfficialBrowserParameters';

/** Translate a COMPLETE adapter snapshot for TrackAudio's real looping buffer
 * reader, never for a causal live-stream processor. FUTURE is positive phase,
 * PAST negative; negative note encoding is independent of time signature.
 * FLICK's 0/50/100 -> stop/1x/2x law is authored, not a measured factory curve.
 * The source route remains partial_source_modes (reverse/live pitch/overdub).
 * Unmodified legacy snapshots are returned verbatim, preserving old projects. */
export function translateBrowserOfficialSourceParameters(
  algorithm: string, parameters: Readonly<Record<string, number>>,
): Readonly<Record<string, number>> {
  const entries = Object.entries(parameters).filter(([key]) => key.startsWith('official_'));
  if (entries.length === 0) return parameters;
  if (!BROWSER_OFFICIAL_SOURCE_ALGORITHMS.includes(algorithm)) throw new RangeError('Not an official source-aware effect');
  const effect = resolveOfficialEffect(algorithm.replace(/-/g, ' ').toUpperCase());
  const selected = getBrowserOfficialDefaults(algorithm);
  for (const [key, value] of entries) {
    const parameter = findOfficialRuntimeParameter(effect, key);
    if (!isBrowserOfficialParameterSupported(algorithm, key) || !parameter || !isOfficialRuntimeValueValid(parameter, value)) {
      throw new RangeError(`Invalid official source-aware ${algorithm} parameter: ${key}`);
    }
    selected[key] = value;
  }
  const result = { ...parameters };
  if (algorithm === 'beat-shift') {
    const length = selected.official_shift ?? -1;
    delete result.beatShiftOffsetBeats;
    result.beatShiftOffsetBeats = length === -1000 ? 0 : Math.abs(length) * (selected.official_type === 1 ? -1 : 1);
  } else {
    delete result.vinylFlickSpeed; delete result.mix; delete result.vinylFlickMixPercent;
    result.vinylFlickSpeed = 2 * (selected.official_flick ?? 50) - 100;
    // Hardware FLICK has no balance control. Its official path selects the
    // source reader only; legacy extension motor timing remains independently editable.
    result.mix = 1;
    result.vinylFlickMixPercent = 100;
  }
  // Raw official keys belong to the adapter snapshot, not TrackAudio aliases.
  for (const [key] of entries) delete result[key];
  return result;
}
