/** Software buses. These do not represent separately addressable hardware ports. */
export type MixerChannel = 'MAIN' | 'MASTER' | 1 | 2 | 3 | 4 | 5;
export interface MixerState {
  readonly available: boolean;
  readonly reason: string;
  readonly main: number | null;
  readonly master: number | null;
  readonly tracks: readonly (number | null)[];
}
export function mixerChannelIndex(channel: MixerChannel): number {
  if (channel === 'MAIN') return 0;
  if (channel === 'MASTER') return 1;
  if (Number.isInteger(channel) && channel >= 1 && channel <= 5) return channel + 1;
  throw new RangeError('Unsupported mixer channel');
}
export function assertMixerLevel(percent: number): void {
  if (!Number.isInteger(percent) || percent < 0 || percent > 200) throw new RangeError('Mixer level must be an integer from 0 to 200');
}
export function mixerState(levels?: readonly number[]): MixerState {
  const valid = levels?.length === 7 && levels.every(level => Number.isInteger(level) && level >= 0 && level <= 200);
  return Object.freeze({available: !!valid, reason: valid ? '' : 'Runtime does not expose software mixer levels', main: valid ? levels[0]! : null,
    master: valid ? levels[1]! : null, tracks: Object.freeze(valid ? levels.slice(2) : [null, null, null, null, null])});
}
