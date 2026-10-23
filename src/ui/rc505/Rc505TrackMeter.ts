export interface Rc505TrackMeterReading { available: boolean; peak: number; rms: number; reason: string }

/** Values come from the post-fader/pre-shared-FX tap, never a gain control. */
export function formatRc505TrackMeter(reading: Rc505TrackMeterReading | undefined): string {
  if (!reading?.available || !Number.isFinite(reading.peak) || !Number.isFinite(reading.rms)
    || reading.peak < 0 || reading.rms < 0) return 'UNAVAILABLE';
  const db = (value: number) => value === 0 ? '-INF' : (20 * Math.log10(value)).toFixed(1);
  return `${db(reading.peak)}/${db(reading.rms)} dB`;
}
