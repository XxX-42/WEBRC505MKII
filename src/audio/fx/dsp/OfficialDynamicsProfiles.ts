/** Independently authored functional interpretations of the manual's names.
 * Roland does not publish these preset detector, EQ or time-constant values.
 * These are not recovered factory presets or measurements of the device. */
export interface OfficialDynamicsProfile {
  name: string; threshold: number; ratio: number; knee: number; attack: number;
  release: number; makeup: number; low: number; high: number; lowCut: number;
  highCut: number; detector: 'peak' | 'rms';
}
type Row = readonly [string, number, number, number, number, number, number, number, number, number, number, 'peak' | 'rms'];
const rows: readonly Row[] = [
  ['NATURALCOMP', -18, 2.5, 12, 20, 180, 2, 0, 0, 0, 0, 'rms'],
  ['MIXER COMP', -20, 3, 6, 10, 100, 3, 0, 0, 0, 0, 'rms'],
  ['LIVE COMP', -16, 4, 4, 5, 80, 3, -1, 1, 0, 0, 'peak'],
  ['NATURAL LIM', -6, 10, 6, 2, 120, 0, 0, 0, 0, 0, 'peak'],
  ['HARD LIM', -3, 20, 0, 0.1, 60, 0, 0, 0, 0, 0, 'peak'],
  ['JINGL COMP', -26, 8, 3, 1, 50, 6, 2, 3, 0, 0, 'rms'],
  ['HARD COMP', -22, 10, 0, 2, 100, 5, 0, 0, 0, 0, 'peak'],
  ['SOFT COMP', -24, 2, 18, 30, 240, 3, 0, 0, 0, 0, 'rms'],
  ['CLEAN COMP', -15, 1.8, 12, 15, 150, 1, 0, 1, 0, 0, 'rms'],
  ['DANCE COMP', -20, 5, 6, 20, 75, 4, 4, 2, 0, 0, 'peak'],
  ['ORCH COMP', -18, 2, 14, 50, 400, 1, 0, 0, 0, 0, 'rms'],
  ['VOCAL COMP', -24, 4, 8, 6, 160, 4, -2, 2, 80, 0, 'rms'],
  ['ACOUSTIC', -18, 2.5, 10, 35, 200, 2, -1, 3, 0, 0, 'rms'],
  ['ROCK BAND', -20, 6, 4, 10, 120, 4, 2, 1, 0, 0, 'peak'],
  ['ORCHESTRA', -12, 1.5, 16, 80, 600, 1, 1, -1, 0, 0, 'rms'],
  ['LOW BOOST', -18, 2.5, 10, 20, 200, 2, 6, 0, 0, 0, 'rms'],
  ['BRIGHTEN', -18, 2, 8, 10, 180, 2, 0, 6, 0, 0, 'rms'],
  ['DJs VOICE', -28, 6, 4, 2, 100, 5, 4, 2, 80, 8500, 'peak'],
  ['PHONE VOX', -24, 5, 2, 2, 100, 3, -6, -3, 300, 3400, 'peak'],
];
export const OFFICIAL_DYNAMICS_PROFILES: readonly Readonly<OfficialDynamicsProfile>[] = Object.freeze(rows.map(([name, threshold, ratio, knee, attack, release, makeup, low, high, lowCut, highCut, detector]) => Object.freeze({ name, threshold, ratio, knee, attack, release, makeup, low, high, lowCut, highCut, detector })));
export function officialDynamicsProfile(type: number): Readonly<OfficialDynamicsProfile> {
  return OFFICIAL_DYNAMICS_PROFILES[Math.max(0, Math.min(18, Math.round(Number.isFinite(type) ? type : 0)))]!;
}
